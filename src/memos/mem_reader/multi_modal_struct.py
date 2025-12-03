import concurrent.futures
import traceback

from typing import Any

from memos import log
from memos.configs.mem_reader import MultiModalStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.mem_reader.read_multi_modal import MultiModalParser
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.item import TextualMemoryItem
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

        # Determine memory_type based on roles (same logic as simple_struct)
        # UserMemory if only user role, else LongTermMemory
        memory_type = "UserMemory" if roles == {"user"} else "LongTermMemory"

        # Merge all memory texts (preserve the format from parser)
        merged_text = "".join(memory_texts) if memory_texts else ""

        if not merged_text.strip():
            # If no text content, return None
            return None

        # Create aggregated memory item (similar to _build_fast_node in simple_struct)
        aggregated_item = self._make_memory_item(
            value=merged_text,
            info=info,
            memory_type=memory_type,
            tags=["mode:fast"],
            sources=all_sources,
        )

        return aggregated_item

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

        fine_memory_items = []

        for fast_item in fast_memory_items:
            # Extract memory text (string content)
            mem_str = fast_item.memory or ""
            if not mem_str.strip():
                continue
            sources = fast_item.metadata.sources or []
            if not isinstance(sources, list):
                sources = [sources]
            try:
                resp = self._get_llm_response(mem_str, custom_tags)
            except Exception as e:
                logger.error(f"[MultiModalFine] Error calling LLM: {e}")
                continue
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
                        info=info,
                        memory_type=memory_type,
                        tags=m.get("tags", []),
                        key=m.get("key", ""),
                        sources=sources,  # Preserve sources from fast item
                        background=resp.get("summary", ""),
                    )
                    fine_memory_items.append(node)
                except Exception as e:
                    logger.error(f"[MultiModalFine] parse error: {e}")

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
