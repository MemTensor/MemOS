import concurrent.futures
import json
import re
import traceback

from typing import Any

from memos import log
from memos.configs.mem_reader import MultiModalStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.mem_reader.read_multi_modal import MultiModalParser, detect_lang
from memos.mem_reader.read_multi_modal.base import _derive_key
from memos.mem_reader.read_skill_memory.process_skill_memory import process_skill_memory_fine
from memos.mem_reader.simple_struct import PROMPT_DICT, SimpleStructMemReader
from memos.mem_reader.utils import parse_json_result
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.templates.mem_reader_prompts import MEMORY_MERGE_PROMPT_EN, MEMORY_MERGE_PROMPT_ZH
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

        # oss
        self.oss_config = getattr(config, "oss_config", None)

        # skills_dir
        self.skills_dir_config = getattr(config, "skills_dir_config", None)

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

            def _create_chunk_item(chunk):
                # Chunk objects have a 'text' attribute
                chunk_text = chunk.text
                if not chunk_text or not chunk_text.strip():
                    return None
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
                    need_embed=False,
                )
                return split_item

            # Use thread pool to parallel process chunks
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                futures = [executor.submit(_create_chunk_item, chunk) for chunk in chunks]
                for future in concurrent.futures.as_completed(futures):
                    split_item = future.result()
                    if split_item is not None:
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
        # control whether to parallel chunk large memory items
        parallel_chunking = True

        if parallel_chunking:
            # parallel chunk large memory items
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                future_to_item = {
                    executor.submit(self._split_large_memory_item, item, max_tokens): item
                    for item in all_memory_items
                    if (item.memory or "") and self._count_tokens(item.memory) > max_tokens
                }
                processed_items.extend(
                    [
                        item
                        for item in all_memory_items
                        if not (
                            (item.memory or "") and self._count_tokens(item.memory) > max_tokens
                        )
                    ]
                )
                # collect split items from futures
                for future in concurrent.futures.as_completed(future_to_item):
                    split_items = future.result()
                    processed_items.extend(split_items)
        else:
            # serial chunk large memory items
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

        # Batch compute embeddings for all windows
        if windows:
            # Collect all valid windows that need embedding
            valid_windows = [w for w in windows if w and w.memory]

            if valid_windows:
                # Collect all texts that need embedding
                texts_to_embed = [w.memory for w in valid_windows]

                # Batch compute all embeddings at once
                try:
                    embeddings = self.embedder.embed(texts_to_embed)
                    # Fill embeddings back into memory items
                    for window, embedding in zip(valid_windows, embeddings, strict=True):
                        window.metadata.embedding = embedding
                except Exception as e:
                    logger.error(f"[MultiModalStruct] Error batch computing embeddings: {e}")
                    # Fallback: compute embeddings individually
                    for window in valid_windows:
                        if window.memory:
                            try:
                                window.metadata.embedding = self.embedder.embed([window.memory])[0]
                            except Exception as e2:
                                logger.error(
                                    f"[MultiModalStruct] Error computing embedding for item: {e2}"
                                )

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

        # Create aggregated memory item without embedding (will be computed in batch later)
        extra_kwargs: dict[str, Any] = {}
        if aggregated_file_ids:
            extra_kwargs["file_ids"] = aggregated_file_ids

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # Create memory item without embedding (set to None, will be filled in batch)
        aggregated_item = TextualMemoryItem(
            memory=merged_text,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=user_id,
                session_id=session_id,
                memory_type=memory_type,
                status="activated",
                tags=["mode:fast"],
                key=_derive_key(merged_text),
                embedding=None,  # Will be computed in batch
                usage=[],
                sources=all_sources,
                background="",
                confidence=0.99,
                type="fact",
                info=info_,
                **extra_kwargs,
            ),
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
        # Determine language: prioritize lang from sources (set in fast mode),
        # fallback to detecting from mem_str if sources don't have lang
        lang = None

        # First, try to get lang from sources (fast mode already set this)
        if sources:
            for source in sources:
                if hasattr(source, "lang") and source.lang:
                    lang = source.lang
                    break
                elif isinstance(source, dict) and source.get("lang"):
                    lang = source.get("lang")
                    break

        # Fallback: detect language from mem_str if no lang from sources
        if lang is None:
            lang = detect_lang(mem_str)

        # Select prompt template based on prompt_type
        if prompt_type == "doc":
            template = PROMPT_DICT["doc"][lang]
            examples = ""  # doc prompts don't have examples
            prompt = template.replace("{chunk_text}", mem_str)
        elif prompt_type == "general_string":
            template = PROMPT_DICT["general_string"][lang]
            examples = ""
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
        if prompt_type in ["doc", "general_string"]:
            prompt = prompt.replace("{custom_tags_prompt}", custom_tags_prompt)
        else:
            prompt = prompt.replace("${custom_tags_prompt}", custom_tags_prompt)

        if self.config.remove_prompt_example and examples:
            prompt = prompt.replace(examples, "")
        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages)
            response_json = parse_json_result(response_text)
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
        logger.info(f"[MultiModalFine] Task {messages}, Result {response_json}")
        return response_json

    def _determine_prompt_type(self, sources: list) -> str:
        """
        Determine prompt type based on sources.
        """
        if not sources:
            return "chat"
        prompt_type = "general_string"
        for source in sources:
            source_role = None
            if hasattr(source, "role"):
                source_role = source.role
            elif isinstance(source, dict):
                source_role = source.get("role")
            if source_role in {"user", "assistant", "system", "tool"}:
                prompt_type = "chat"

        return prompt_type

    def _get_maybe_merged_memory(
        self,
        extracted_memory_dict: dict,
        mem_text: str,
        sources: list,
        **kwargs,
    ) -> dict:
        """
        Check if extracted memory should be merged with similar existing memories.
        If merge is needed, return merged memory dict with merged_from field.
        Otherwise, return original memory dict.

        Args:
            extracted_memory_dict: The extracted memory dict from LLM response
            mem_text: The memory text content
            sources: Source messages for language detection
            **kwargs: Additional parameters (merge_similarity_threshold, etc.)

        Returns:
            Memory dict (possibly merged) with merged_from field if merged
        """
        # If no graph_db or user_name, return original
        if not self.graph_db or "user_name" not in kwargs:
            return extracted_memory_dict
        user_name = kwargs.get("user_name")

        # Detect language
        lang = "en"
        if sources:
            for source in sources:
                if hasattr(source, "lang") and source.lang:
                    lang = source.lang
                    break
                elif isinstance(source, dict) and source.get("lang"):
                    lang = source.get("lang")
                    break
        if lang is None:
            lang = detect_lang(mem_text)

        # Search for similar memories
        merge_threshold = kwargs.get("merge_similarity_threshold", 0.3)

        try:
            search_results = self.graph_db.search_by_embedding(
                vector=self.embedder.embed(mem_text)[0],
                top_k=20,
                status="activated",
                threshold=merge_threshold,
                user_name=user_name,
            )

            if not search_results:
                return extracted_memory_dict

            # Get full memory details
            similar_memory_ids = [r["id"] for r in search_results if r.get("id")]
            similar_memories_list = [
                self.graph_db.get_node(mem_id, include_embedding=False, user_name=user_name)
                for mem_id in similar_memory_ids
            ]

            # Filter out None and mode:fast memories
            filtered_similar = []
            for mem in similar_memories_list:
                if not mem:
                    continue
                mem_metadata = mem.get("metadata", {})
                tags = mem_metadata.get("tags", [])
                if isinstance(tags, list) and "mode:fast" in tags:
                    continue
                filtered_similar.append(
                    {
                        "id": mem.get("id"),
                        "memory": mem.get("memory", ""),
                    }
                )
            logger.info(
                f"Valid similar memories for {mem_text} is "
                f"{len(filtered_similar)}: {filtered_similar}"
            )

            if not filtered_similar:
                return extracted_memory_dict

            # Create a temporary TextualMemoryItem for merge check
            temp_memory_item = TextualMemoryItem(
                memory=mem_text,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id="",
                    session_id="",
                    memory_type=extracted_memory_dict.get("memory_type", "LongTermMemory"),
                    status="activated",
                    tags=extracted_memory_dict.get("tags", []),
                    key=extracted_memory_dict.get("key", ""),
                ),
            )

            # Try to merge with LLM
            merge_result = self._merge_memories_with_llm(
                temp_memory_item, filtered_similar, lang=lang
            )

            if merge_result:
                # Return merged memory dict
                merged_dict = extracted_memory_dict.copy()
                merged_content = merge_result.get("value", mem_text)
                merged_dict["value"] = merged_content
                merged_from_ids = merge_result.get("merged_from", [])
                merged_dict["merged_from"] = merged_from_ids
                return merged_dict
            else:
                return extracted_memory_dict

        except Exception as e:
            logger.error(f"[MultiModalFine] Error in get_maybe_merged_memory: {e}")
            # On error, return original
            return extracted_memory_dict

    def _merge_memories_with_llm(
        self,
        new_memory: TextualMemoryItem,
        similar_memories: list[dict],
        lang: str = "en",
    ) -> dict | None:
        """
        Use LLM to merge new memory with similar existing memories.

        Args:
            new_memory: The newly extracted memory item
            similar_memories: List of similar memories from graph_db (with id and memory fields)
            lang: Language code ("en" or "zh")

        Returns:
            Merged memory dict with merged_from field, or None if no merge needed
        """
        if not similar_memories:
            return None

        # Build merge prompt using template
        similar_memories_text = "\n".join(
            [f"[{mem['id']}]: {mem['memory']}" for mem in similar_memories]
        )

        merge_prompt_template = MEMORY_MERGE_PROMPT_ZH if lang == "zh" else MEMORY_MERGE_PROMPT_EN
        merge_prompt = merge_prompt_template.format(
            new_memory=new_memory.memory,
            similar_memories=similar_memories_text,
        )

        try:
            response_text = self.llm.generate([{"role": "user", "content": merge_prompt}])
            merge_result = parse_json_result(response_text)

            if merge_result.get("should_merge", False):
                return {
                    "value": merge_result.get("value", new_memory.memory),
                    "merged_from": merge_result.get(
                        "merged_from", [mem["id"] for mem in similar_memories]
                    ),
                }
        except Exception as e:
            logger.error(f"[MultiModalFine] Error in merge LLM call: {e}")

        return None

    def _process_string_fine(
        self,
        fast_memory_items: list[TextualMemoryItem],
        info: dict[str, Any],
        custom_tags: list[str] | None = None,
        **kwargs,
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

            # ========== Stage 1: Normal extraction (without reference) ==========
            try:
                resp = self._get_llm_response(mem_str, custom_tags, sources, prompt_type)
            except Exception as e:
                logger.error(f"[MultiModalFine] Error calling LLM: {e}")
                return fine_items

            if resp.get("memory list", []):
                for m in resp.get("memory list", []):
                    try:
                        # Check and merge with similar memories if needed
                        m_maybe_merged = self._get_maybe_merged_memory(
                            extracted_memory_dict=m,
                            mem_text=m.get("value", ""),
                            sources=sources,
                            original_query=mem_str,
                            **kwargs,
                        )
                        # Normalize memory_type (same as simple_struct)
                        memory_type = (
                            m_maybe_merged.get("memory_type", "LongTermMemory")
                            .replace("长期记忆", "LongTermMemory")
                            .replace("用户记忆", "UserMemory")
                        )
                        node = self._make_memory_item(
                            value=m_maybe_merged.get("value", ""),
                            info=info_per_item,
                            memory_type=memory_type,
                            tags=m_maybe_merged.get("tags", []),
                            key=m_maybe_merged.get("key", ""),
                            sources=sources,  # Preserve sources from fast item
                            background=resp.get("summary", ""),
                            **extra_kwargs,
                        )
                        # Add merged_from to info if present
                        if "merged_from" in m_maybe_merged:
                            node.metadata.info = node.metadata.info or {}
                            node.metadata.info["merged_from"] = m_maybe_merged["merged_from"]
                        fine_items.append(node)
                    except Exception as e:
                        logger.error(f"[MultiModalFine] parse error: {e}")
            elif resp.get("value") and resp.get("key"):
                try:
                    # Check and merge with similar memories if needed
                    resp_maybe_merged = self._get_maybe_merged_memory(
                        extracted_memory_dict=resp,
                        mem_text=resp.get("value", "").strip(),
                        sources=sources,
                        original_query=mem_str,
                        **kwargs,
                    )
                    node = self._make_memory_item(
                        value=resp_maybe_merged.get("value", "").strip(),
                        info=info_per_item,
                        memory_type="LongTermMemory",
                        tags=resp_maybe_merged.get("tags", []),
                        key=resp_maybe_merged.get("key", None),
                        sources=sources,  # Preserve sources from fast item
                        background=resp.get("summary", ""),
                        **extra_kwargs,
                    )
                    # Add merged_from to info if present
                    if "merged_from" in resp_maybe_merged:
                        node.metadata.info = node.metadata.info or {}
                        node.metadata.info["merged_from"] = resp_maybe_merged["merged_from"]
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
        self, fast_memory_items: list[TextualMemoryItem], info: dict[str, Any], **kwargs
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
            if not mem_str.strip() or (
                "tool:" not in mem_str
                and "[tool_calls]:" not in mem_str
                and not re.search(r"<tool_schema>.*?</tool_schema>", mem_str, re.DOTALL)
            ):
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
                        correctness=m.get("correctness", ""),
                        experience=m.get("experience", ""),
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
            # Use thread pool to parse each message in parallel
            with ContextThreadPoolExecutor(max_workers=30) as executor:
                futures = [
                    executor.submit(
                        self.multi_modal_parser.parse,
                        msg,
                        info,
                        mode="fast",
                        need_emb=False,
                        **kwargs,
                    )
                    for msg in scene_data_info
                ]
                for future in concurrent.futures.as_completed(futures):
                    try:
                        items = future.result()
                        all_memory_items.extend(items)
                    except Exception as e:
                        logger.error(f"[MultiModalFine] Error in parallel parsing: {e}")
        else:
            # Parse as single message
            all_memory_items = self.multi_modal_parser.parse(
                scene_data_info, info, mode="fast", need_emb=False, **kwargs
            )
        fast_memory_items = self._concat_multi_modal_memories(all_memory_items)
        if mode == "fast":
            return fast_memory_items
        else:
            # Part A: call llm in parallel using thread pool
            fine_memory_items = []

            with ContextThreadPoolExecutor(max_workers=3) as executor:
                future_string = executor.submit(
                    self._process_string_fine, fast_memory_items, info, custom_tags, **kwargs
                )
                future_tool = executor.submit(
                    self._process_tool_trajectory_fine, fast_memory_items, info, **kwargs
                )
                future_skill = executor.submit(
                    process_skill_memory_fine,
                    fast_memory_items=fast_memory_items,
                    info=info,
                    searcher=self.searcher,
                    graph_db=self.graph_db,
                    llm=self.llm,
                    embedder=self.embedder,
                    oss_config=self.oss_config,
                    skills_dir_config=self.skills_dir_config,
                    **kwargs,
                )

                # Collect results
                fine_memory_items_string_parser = future_string.result()
                fine_memory_items_tool_trajectory_parser = future_tool.result()
                fine_memory_items_skill_memory_parser = future_skill.result()

            fine_memory_items.extend(fine_memory_items_string_parser)
            fine_memory_items.extend(fine_memory_items_tool_trajectory_parser)
            fine_memory_items.extend(fine_memory_items_skill_memory_parser)

            # Part B: get fine multimodal items
            for fast_item in fast_memory_items:
                sources = fast_item.metadata.sources
                for source in sources:
                    lang = getattr(source, "lang", "en")
                    items = self.multi_modal_parser.process_transfer(
                        source,
                        context_items=[fast_item],
                        custom_tags=custom_tags,
                        info=info,
                        lang=lang,
                    )
                    fine_memory_items.extend(items)
            return fine_memory_items

    @timed
    def _process_transfer_multi_modal_data(
        self, raw_nodes: list[TextualMemoryItem], custom_tags: list[str] | None = None, **kwargs
    ) -> list[TextualMemoryItem]:
        """
        Process transfer for multimodal data.

        Each source is processed independently by its corresponding parser,
        which knows how to rebuild the original message and parse it in fine mode.
        """
        if not raw_nodes:
            logger.warning("[MultiModalStruct] No raw nodes found.")
            return []

        # Extract info from raw_nodes (same as simple_struct.py)
        info = {
            "user_id": raw_nodes[0].metadata.user_id,
            "session_id": raw_nodes[0].metadata.session_id,
            **(raw_nodes[0].metadata.info or {}),
        }

        fine_memory_items = []
        # Part A: call llm in parallel using thread pool
        with ContextThreadPoolExecutor(max_workers=2) as executor:
            future_string = executor.submit(
                self._process_string_fine, raw_nodes, info, custom_tags, **kwargs
            )
            future_tool = executor.submit(
                self._process_tool_trajectory_fine, raw_nodes, info, **kwargs
            )
            future_skill = executor.submit(
                process_skill_memory_fine,
                raw_nodes,
                info,
                searcher=self.searcher,
                llm=self.llm,
                embedder=self.embedder,
                graph_db=self.graph_db,
                oss_config=self.oss_config,
                skills_dir_config=self.skills_dir_config,
                **kwargs,
            )

            # Collect results
            fine_memory_items_string_parser = future_string.result()
            fine_memory_items_tool_trajectory_parser = future_tool.result()
            fine_memory_items_skill_memory_parser = future_skill.result()
        fine_memory_items.extend(fine_memory_items_string_parser)
        fine_memory_items.extend(fine_memory_items_tool_trajectory_parser)
        fine_memory_items.extend(fine_memory_items_skill_memory_parser)

        # Part B: get fine multimodal items
        for raw_node in raw_nodes:
            sources = raw_node.metadata.sources
            for source in sources:
                lang = getattr(source, "lang", "en")
                items = self.multi_modal_parser.process_transfer(
                    source, context_items=[raw_node], info=info, custom_tags=custom_tags, lang=lang
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
        self,
        messages: list[MessagesType],
        type: str,
        info: dict[str, Any],
        mode: str = "fine",
        **kwargs,
    ) -> list[list[TextualMemoryItem]]:
        list_scene_data_info = self.get_scene_data_info(messages, type)

        memory_list = []
        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(
                    self._process_multi_modal_data, scene_data_info, info, mode=mode, **kwargs
                )
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
        **kwargs,
    ) -> list[list[TextualMemoryItem]]:
        if not input_memories:
            return []

        # Process Q&A pairs concurrently with context propagation
        memory_list = self._process_transfer_multi_modal_data(input_memories, custom_tags, **kwargs)

        return [memory_list]
