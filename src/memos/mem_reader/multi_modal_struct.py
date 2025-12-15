import concurrent.futures
import json
import traceback

from typing import Any

from memos import log
from memos.configs.mem_reader import MultiModalStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.mem_reader.read_multi_modal import MultiModalParser, detect_lang
from memos.mem_reader.simple_struct import PROMPT_DICT, SimpleStructMemReader
from memos.memories.textual.item import TextualMemoryItem
from memos.templates.tool_mem_prompts import TOOL_TRAJECTORY_PROMPT_EN, TOOL_TRAJECTORY_PROMPT_ZH
from memos.types import MessagesType
from memos.utils import timed


logger = log.get_logger(__name__)


class MultiModalStructMemReader(SimpleStructMemReader):
    """Multimodal implementation of MemReader that inherits from
    SimpleStructMemReader."""

    def __init__(self, config: MultiModalStructMemReaderConfig):
        """
        Initialize the MultiModalStructMemReader with configuration.

        Args:
            config: Configuration object for the reader
        """
        from memos.configs.mem_reader import SimpleStructMemReaderConfig

        # Extract direct_markdown_hostnames before converting to SimpleStructMemReaderConfig
        direct_markdown_hostnames = getattr(config, "direct_markdown_hostnames", None)

        # Create config_dict excluding direct_markdown_hostnames for SimpleStructMemReaderConfig
        config_dict = config.model_dump(exclude_none=True)
        config_dict.pop("direct_markdown_hostnames", None)

        simple_config = SimpleStructMemReaderConfig(**config_dict)
        super().__init__(simple_config)

        # Initialize MultiModalParser for routing to different parsers
        self.multi_modal_parser = MultiModalParser(
            embedder=self.embedder,
            llm=self.llm,
            parser=None,
            direct_markdown_hostnames=direct_markdown_hostnames,
        )

    def _split_large_memory_item(
        self, item: TextualMemoryItem, max_tokens: int
    ) -> list[TextualMemoryItem]:
        """
        Split a single memory item that exceeds max_tokens into multiple chunks.

        Args:
            item: TextualMemoryItem to split
            max_tokens: Maximum tokens per chunk

        Returns:
            List of TextualMemoryItem chunks
        """
        item_text = item.memory or ""
        if not item_text:
            return [item]

        item_tokens = self._count_tokens(item_text)
        if item_tokens <= max_tokens:
            return [item]

        # Use chunker to split the text
        try:
            chunks = self.chunker.chunk(item_text)
            split_items = []

            for chunk in chunks:
                # Chunk objects have a 'text' attribute
                chunk_text = chunk.text
                if not chunk_text or not chunk_text.strip():
                    continue

                # Create a new memory item for each chunk, preserving original metadata
                split_item = self._make_memory_item(
                    value=chunk_text,
                    info={
                        "user_id": item.metadata.user_id,
                        "session_id": item.metadata.session_id,
                        **(item.metadata.info or {}),
                    },
                    memory_type=item.metadata.memory_type,
                    tags=item.metadata.tags or [],
                    key=item.metadata.key,
                    sources=item.metadata.sources or [],
                    background=item.metadata.background or "",
                )
                split_items.append(split_item)

            return split_items if split_items else [item]
        except Exception as e:
            logger.warning(
                f"[MultiModalStruct] Failed to split large memory item: {e}. Returning original item."
            )
            return [item]

    def _concat_multi_modal_memories(
        self, all_memory_items: list[TextualMemoryItem], max_tokens=None, overlap=200
    ) -> list[TextualMemoryItem]:
        """
        Aggregates memory items using sliding window logic similar to
        `_iter_chat_windows` in simple_struct:
        1. Groups items into windows based on token count (max_tokens)
        2. Each window has overlap tokens for context continuity
        3. Aggregates items within each window into a single memory item
        4. Determines memory_type based on roles in each window
        5. Splits single large memory items that exceed max_tokens
        """
        if not all_memory_items:
            return []

        max_tokens = max_tokens or self.chat_window_max_tokens

        # Split large memory items before processing
        processed_items = []
        for item in all_memory_items:
            item_text = item.memory or ""
            item_tokens = self._count_tokens(item_text)
            if item_tokens > max_tokens:
                # Split the large item into multiple chunks
                split_items = self._split_large_memory_item(item, max_tokens)
                processed_items.extend(split_items)
            else:
                processed_items.append(item)

        # If only one item after processing, return as-is
        if len(processed_items) == 1:
            return processed_items

        windows = []
        buf_items = []
        cur_text = ""

        # Extract info from first item (all items should have same user_id, session_id)
        first_item = processed_items[0]
        info = {
            "user_id": first_item.metadata.user_id,
            "session_id": first_item.metadata.session_id,
            **(first_item.metadata.info or {}),
        }

        for _idx, item in enumerate(processed_items):
            item_text = item.memory or ""
            # Ensure line ends with newline (same format as simple_struct)
            line = item_text if item_text.endswith("\n") else f"{item_text}\n"

            # Check if adding this item would exceed max_tokens (same logic as _iter_chat_windows)
            # Note: After splitting large items, each item should be <= max_tokens,
            # but we still check to handle edge cases
            if self._count_tokens(cur_text + line) > max_tokens and cur_text:
                # Yield current window
                window = self._build_window_from_items(buf_items, info)
                if window:
                    windows.append(window)

                # Keep overlap: remove items until remaining tokens <= overlap
                # (same logic as _iter_chat_windows)
                while (
                    buf_items
                    and self._count_tokens("".join([it.memory or "" for it in buf_items])) > overlap
                ):
                    buf_items.pop(0)
                # Recalculate cur_text from remaining items
                cur_text = "".join([it.memory or "" for it in buf_items])

            # Add item to current window
            buf_items.append(item)
            # Recalculate cur_text from all items in buffer (same as _iter_chat_windows)
            cur_text = "".join([it.memory or "" for it in buf_items])

        # Yield final window if any items remain
        if buf_items:
            window = self._build_window_from_items(buf_items, info)
            if window:
                windows.append(window)

        return windows

    def _build_window_from_items(
        self, items: list[TextualMemoryItem], info: dict[str, Any]
    ) -> TextualMemoryItem | None:
        """
        Build a single memory item from a window of items (similar to _build_fast_node).

        Args:
            items: List of TextualMemoryItem objects in the window
            info: Dictionary containing user_id and session_id

        Returns:
            Aggregated TextualMemoryItem or None if no valid content
        """
        if not items:
            return None

        # Collect all memory texts and sources
        memory_texts = []
        all_sources = []
        roles = set()
        aggregated_file_ids: list[str] = []

        for item in items:
            if item.memory:
                memory_texts.append(item.memory)

            # Collect sources and extract roles
            item_sources = item.metadata.sources or []
            if not isinstance(item_sources, list):
                item_sources = [item_sources]

            for source in item_sources:
                # Add source to all_sources
                all_sources.append(source)

                # Extract role from source
                if hasattr(source, "role") and source.role:
                    roles.add(source.role)
                elif isinstance(source, dict) and source.get("role"):
                    roles.add(source.get("role"))

            # Aggregate file_ids from metadata
            metadata = getattr(item, "metadata", None)
            if metadata is not None:
                item_file_ids = getattr(metadata, "file_ids", None)
                if isinstance(item_file_ids, list):
                    for fid in item_file_ids:
                        if fid and fid not in aggregated_file_ids:
                            aggregated_file_ids.append(fid)

        # Determine memory_type based on roles (same logic as simple_struct)
        # UserMemory if only user role, else LongTermMemory
        memory_type = "UserMemory" if roles == {"user"} else "LongTermMemory"

        # Merge all memory texts (preserve the format from parser)
        merged_text = "".join(memory_texts) if memory_texts else ""

        if not merged_text.strip():
            # If no text content, return None
            return None

        # Create aggregated memory item (similar to _build_fast_node in simple_struct)
        extra_kwargs: dict[str, Any] = {}
        if aggregated_file_ids:
            extra_kwargs["file_ids"] = aggregated_file_ids
        aggregated_item = self._make_memory_item(
            value=merged_text,
            info=info,
            memory_type=memory_type,
            tags=["mode:fast"],
            sources=all_sources,
            **extra_kwargs,
        )

        return aggregated_item

    def _get_llm_response(
        self,
        mem_str: str,
        custom_tags: list[str] | None = None,
        sources: list | None = None,
        prompt_type: str = "chat",
    ) -> dict:
        """
        Override parent method to improve language detection by using actual text content
        from sources instead of JSON-structured memory string.

        Args:
            mem_str: Memory string (may contain JSON structures)
            custom_tags: Optional custom tags
            sources: Optional list of SourceMessage objects to extract text content from
            prompt_type: Type of prompt to use ("chat" or "doc")

        Returns:
            LLM response dictionary
        """
        # Try to extract actual text content from sources for better language detection
        text_for_lang_detection = mem_str
        if sources:
            source_texts = []
            for source in sources:
                if hasattr(source, "content") and source.content:
                    source_texts.append(source.content)
                elif isinstance(source, dict) and source.get("content"):
                    source_texts.append(source.get("content"))

            # If we have text content from sources, use it for language detection
            if source_texts:
                text_for_lang_detection = " ".join(source_texts)

        # Use the extracted text for language detection
        lang = detect_lang(text_for_lang_detection)

        # Select prompt template based on prompt_type
        if prompt_type == "doc":
            template = PROMPT_DICT["doc"][lang]
            examples = ""  # doc prompts don't have examples
            prompt = template.replace("{chunk_text}", mem_str)
        else:
            template = PROMPT_DICT["chat"][lang]
            examples = PROMPT_DICT["chat"][f"{lang}_example"]
            prompt = template.replace("${conversation}", mem_str)

        custom_tags_prompt = (
            PROMPT_DICT["custom_tags"][lang].replace("{custom_tags}", str(custom_tags))
            if custom_tags
            else ""
        )

        # Replace custom_tags_prompt placeholder (different for doc vs chat)
        if prompt_type == "doc":
            prompt = prompt.replace("{custom_tags_prompt}", custom_tags_prompt)
        else:
            prompt = prompt.replace("${custom_tags_prompt}", custom_tags_prompt)

        if self.config.remove_prompt_example and examples:
            prompt = prompt.replace(examples, "")
        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages)
            response_json = self.parse_json_result(response_text)
        except Exception as e:
            logger.error(f"[LLM] Exception during chat generation: {e}")
            response_json = {
                "memory list": [
                    {
                        "key": mem_str[:10],
                        "memory_type": "UserMemory",
                        "value": mem_str,
                        "tags": [],
                    }
                ],
                "summary": mem_str,
            }
        return response_json

    def _determine_prompt_type(self, sources: list) -> str:
        """
        Determine prompt type based on sources.
        """
        if not sources:
            return "chat"
        prompt_type = "doc"
        for source in sources:
            source_role = None
            if hasattr(source, "role"):
                source_role = source.role
            elif isinstance(source, dict):
                source_role = source.get("role")
            if source_role in {"user", "assistant", "system", "tool"}:
                prompt_type = "chat"

        return prompt_type

    def _process_string_fine(
        self,
        fast_memory_items: list[TextualMemoryItem],
        info: dict[str, Any],
        custom_tags: list[str] | None = None,
    ) -> list[TextualMemoryItem]:
        """
        Process fast mode memory items through LLM to generate fine mode memories.
        """
        if not fast_memory_items:
            return []

        def _process_one_item(fast_item: TextualMemoryItem) -> list[TextualMemoryItem]:
            """Process a single fast memory item and return a list of fine items."""
            fine_items: list[TextualMemoryItem] = []

            # Extract memory text (string content)
            mem_str = fast_item.memory or ""
            if not mem_str.strip():
                return fine_items

            sources = fast_item.metadata.sources or []
            if not isinstance(sources, list):
                sources = [sources]

            # Extract file_ids from fast item metadata for propagation
            metadata = getattr(fast_item, "metadata", None)
            file_ids = getattr(metadata, "file_ids", None) if metadata is not None else None
            file_ids = [fid for fid in file_ids if fid] if isinstance(file_ids, list) else []

            # Build per-item info copy and kwargs for _make_memory_item
            info_per_item = info.copy()
            if file_ids and "file_id" not in info_per_item:
                info_per_item["file_id"] = file_ids[0]
            extra_kwargs: dict[str, Any] = {}
            if file_ids:
                extra_kwargs["file_ids"] = file_ids

            # Determine prompt type based on sources
            prompt_type = self._determine_prompt_type(sources)

            try:
                resp = self._get_llm_response(mem_str, custom_tags, sources, prompt_type)
            except Exception as e:
                logger.error(f"[MultiModalFine] Error calling LLM: {e}")
                return fine_items

            if resp.get("memory list", []):
                for m in resp.get("memory list", []):
                    try:
                        # Normalize memory_type (same as simple_struct)
                        memory_type = (
                            m.get("memory_type", "LongTermMemory")
                            .replace("长期记忆", "LongTermMemory")
                            .replace("用户记忆", "UserMemory")
                        )
                        # Create fine mode memory item (same as simple_struct)
                        node = self._make_memory_item(
                            value=m.get("value", ""),
                            info=info_per_item,
                            memory_type=memory_type,
                            tags=m.get("tags", []),
                            key=m.get("key", ""),
                            sources=sources,  # Preserve sources from fast item
                            background=resp.get("summary", ""),
                            **extra_kwargs,
                        )
                        fine_items.append(node)
                    except Exception as e:
                        logger.error(f"[MultiModalFine] parse error: {e}")
            elif resp.get("value") and resp.get("key"):
                try:
                    # Create fine mode memory item (same as simple_struct)
                    node = self._make_memory_item(
                        value=resp.get("value", "").strip(),
                        info=info_per_item,
                        memory_type="LongTermMemory",
                        tags=resp.get("tags", []),
                        key=resp.get("key", None),
                        sources=sources,  # Preserve sources from fast item
                        background=resp.get("summary", ""),
                        **extra_kwargs,
                    )
                    fine_items.append(node)
                except Exception as e:
                    logger.error(f"[MultiModalFine] parse error: {e}")

            return fine_items

        fine_memory_items: list[TextualMemoryItem] = []

        with ContextThreadPoolExecutor(max_workers=30) as executor:
            futures = [executor.submit(_process_one_item, item) for item in fast_memory_items]

            for future in concurrent.futures.as_completed(futures):
                try:
                    result = future.result()
                    if result:
                        fine_memory_items.extend(result)
                except Exception as e:
                    logger.error(f"[MultiModalFine] worker error: {e}")

        return fine_memory_items

    def _get_llm_tool_trajectory_response(self, mem_str: str) -> dict:
        """
        Generete tool trajectory experience item by llm.
        """
        try:
            lang = detect_lang(mem_str)
            template = TOOL_TRAJECTORY_PROMPT_ZH if lang == "zh" else TOOL_TRAJECTORY_PROMPT_EN
            prompt = template.replace("{messages}", mem_str)
            rsp = self.llm.generate([{"role": "user", "content": prompt}])
            rsp = rsp.replace("```json", "").replace("```", "")
            return json.loads(rsp)
        except Exception as e:
            logger.error(f"[MultiModalFine] Error calling LLM for tool trajectory: {e}")
            return []

    def _process_tool_trajectory_fine(
        self,
        fast_memory_items: list[TextualMemoryItem],
        info: dict[str, Any],
    ) -> list[TextualMemoryItem]:
        """
        Process tool trajectory memory items through LLM to generate fine mode memories.
        """
        if not fast_memory_items:
            return []

        fine_memory_items = []

        for fast_item in fast_memory_items:
            # Extract memory text (string content)
            mem_str = fast_item.memory or ""
            if not mem_str.strip() or "tool:" not in mem_str:
                continue
            try:
                resp = self._get_llm_tool_trajectory_response(mem_str)
            except Exception as e:
                logger.error(f"[MultiModalFine] Error calling LLM for tool trajectory: {e}")
                continue
            for m in resp:
                try:
                    # Normalize memory_type (same as simple_struct)
                    memory_type = "ToolTrajectoryMemory"

                    node = self._make_memory_item(
                        value=m.get("trajectory", ""),
                        info=info,
                        memory_type=memory_type,
                        tool_used_status=m.get("tool_used_status", []),
                    )
                    fine_memory_items.append(node)
                except Exception as e:
                    logger.error(f"[MultiModalFine] parse error for tool trajectory: {e}")

        return fine_memory_items

    @timed
    def _process_multi_modal_data(
        self, scene_data_info: MessagesType, info, mode: str = "fine", **kwargs
    ) -> list[TextualMemoryItem]:
        """
        Process multimodal data using MultiModalParser.

        Args:
            scene_data_info: MessagesType input
            info: Dictionary containing user_id and session_id
            mode: mem-reader mode, fast for quick process while fine for
            better understanding via calling llm
            **kwargs: Additional parameters (mode, etc.)
        """
        # Pop custom_tags from info (same as simple_struct.py)
        # must pop here, avoid add to info, only used in sync fine mode
        custom_tags = info.pop("custom_tags", None) if isinstance(info, dict) else None

        # Use MultiModalParser to parse the scene data
        # If it's a list, parse each item; otherwise parse as single message
        if isinstance(scene_data_info, list):
            # Parse each message in the list
            all_memory_items = []
            for msg in scene_data_info:
                items = self.multi_modal_parser.parse(msg, info, mode="fast", **kwargs)
                all_memory_items.extend(items)
        else:
            # Parse as single message
            all_memory_items = self.multi_modal_parser.parse(
                scene_data_info, info, mode="fast", **kwargs
            )
        fast_memory_items = self._concat_multi_modal_memories(all_memory_items)
        if mode == "fast":
            return fast_memory_items
        else:
            # Part A: call llm
            fine_memory_items = []
            fine_memory_items_string_parser = self._process_string_fine(
                fast_memory_items, info, custom_tags
            )
            fine_memory_items.extend(fine_memory_items_string_parser)

            fine_memory_items_tool_trajectory_parser = self._process_tool_trajectory_fine(
                fast_memory_items, info
            )
            fine_memory_items.extend(fine_memory_items_tool_trajectory_parser)

            # Part B: get fine multimodal items
            for fast_item in fast_memory_items:
                sources = fast_item.metadata.sources
                for source in sources:
                    items = self.multi_modal_parser.process_transfer(
                        source, context_items=[fast_item], custom_tags=custom_tags, info=info
                    )
                    fine_memory_items.extend(items)
            return fine_memory_items

    @timed
    def _process_transfer_multi_modal_data(
        self,
        raw_node: TextualMemoryItem,
        custom_tags: list[str] | None = None,
    ) -> list[TextualMemoryItem]:
        """
        Process transfer for multimodal data.

        Each source is processed independently by its corresponding parser,
        which knows how to rebuild the original message and parse it in fine mode.
        """
        sources = raw_node.metadata.sources or []
        if not sources:
            logger.warning("[MultiModalStruct] No sources found in raw_node")
            return []

        # Extract info from raw_node (same as simple_struct.py)
        info = {
            "user_id": raw_node.metadata.user_id,
            "session_id": raw_node.metadata.session_id,
            **(raw_node.metadata.info or {}),
        }

        fine_memory_items = []
        # Part A: call llm
        fine_memory_items_string_parser = self._process_string_fine([raw_node], info, custom_tags)
        fine_memory_items.extend(fine_memory_items_string_parser)

        fine_memory_items_tool_trajectory_parser = self._process_tool_trajectory_fine(
            [raw_node], info
        )
        fine_memory_items.extend(fine_memory_items_tool_trajectory_parser)

        # Part B: get fine multimodal items
        for source in sources:
            items = self.multi_modal_parser.process_transfer(
                source, context_items=[raw_node], info=info, custom_tags=custom_tags
            )
            fine_memory_items.extend(items)
        return fine_memory_items

    def get_scene_data_info(self, scene_data: list, type: str) -> list[list[Any]]:
        """
        Convert normalized MessagesType scenes into scene data info.
        For MultiModalStructMemReader, this is a simplified version that returns the scenes as-is.

        Args:
            scene_data: List of MessagesType scenes
            type: Type of scene_data: ['doc', 'chat']

        Returns:
            List of scene data info
        """
        # TODO: split messages
        return scene_data

    def _read_memory(
        self, messages: list[MessagesType], type: str, info: dict[str, Any], mode: str = "fine"
    ) -> list[list[TextualMemoryItem]]:
        list_scene_data_info = self.get_scene_data_info(messages, type)

        memory_list = []
        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(self._process_multi_modal_data, scene_data_info, info, mode=mode)
                for scene_data_info in list_scene_data_info
            ]
            for future in concurrent.futures.as_completed(futures):
                try:
                    res_memory = future.result()
                    if res_memory is not None:
                        memory_list.append(res_memory)
                except Exception as e:
                    logger.error(f"Task failed with exception: {e}")
                    logger.error(traceback.format_exc())
        return memory_list

    def fine_transfer_simple_mem(
        self,
        input_memories: list[TextualMemoryItem],
        type: str,
        custom_tags: list[str] | None = None,
    ) -> list[list[TextualMemoryItem]]:
        if not input_memories:
            return []

        memory_list = []

        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(
                    self._process_transfer_multi_modal_data, scene_data_info, custom_tags
                )
                for scene_data_info in input_memories
            ]
            for future in concurrent.futures.as_completed(futures):
                try:
                    res_memory = future.result()
                    if res_memory is not None:
                        memory_list.append(res_memory)
                except Exception as e:
                    logger.error(f"Task failed with exception: {e}")
                    logger.error(traceback.format_exc())
        return memory_list
