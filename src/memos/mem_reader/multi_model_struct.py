import concurrent.futures
import traceback

from typing import Any

from memos import log
from memos.configs.mem_reader import MultiModelStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessagesType
from memos.utils import timed


logger = log.get_logger(__name__)


class MultiModelStructMemReader(SimpleStructMemReader):
    """Multi Model implementation of MemReader that inherits from
    SimpleStructMemReader."""

    def __init__(self, config: MultiModelStructMemReaderConfig):
        """
        Initialize the MultiModelStructMemReader with configuration.

        Args:
            config: Configuration object for the reader
        """
        from memos.configs.mem_reader import SimpleStructMemReaderConfig

        simple_config = SimpleStructMemReaderConfig(**config.model_dump())
        super().__init__(simple_config)

    @timed
    def _process_multi_model_data(self, scene_data_info, info, **kwargs):
        mode = kwargs.get("mode", "fine")
        windows = list(self._iter_chat_windows(scene_data_info))

        if mode == "fast":
            logger.debug("Using unified Fast Mode")

            def _build_fast_node(w):
                text = w["text"]
                roles = {s.get("role", "") for s in w["sources"] if s.get("role")}
                mem_type = "UserMemory" if roles == {"user"} else "LongTermMemory"
                tags = ["mode:fast"]
                return self._make_memory_item(
                    value=text, info=info, memory_type=mem_type, tags=tags, sources=w["sources"]
                )

            with ContextThreadPoolExecutor(max_workers=8) as ex:
                futures = {ex.submit(_build_fast_node, w): i for i, w in enumerate(windows)}
                results = [None] * len(futures)
                for fut in concurrent.futures.as_completed(futures):
                    i = futures[fut]
                    try:
                        node = fut.result()
                        if node:
                            results[i] = node
                    except Exception as e:
                        logger.error(f"[ChatFast] error: {e}")
                chat_nodes = [r for r in results if r]
            return chat_nodes
        else:
            logger.debug("Using unified Fine Mode")
            chat_read_nodes = []
            for w in windows:
                resp = self._get_llm_response(w["text"])
                for m in resp.get("memory list", []):
                    try:
                        memory_type = (
                            m.get("memory_type", "LongTermMemory")
                            .replace("长期记忆", "LongTermMemory")
                            .replace("用户记忆", "UserMemory")
                        )
                        node = self._make_memory_item(
                            value=m.get("value", ""),
                            info=info,
                            memory_type=memory_type,
                            tags=m.get("tags", []),
                            key=m.get("key", ""),
                            sources=w["sources"],
                            background=resp.get("summary", ""),
                        )
                        chat_read_nodes.append(node)
                    except Exception as e:
                        logger.error(f"[ChatFine] parse error: {e}")
            return chat_read_nodes

    @timed
    def _process_transfer_multi_model_data(self, raw_node: TextualMemoryItem):
        raw_memory = raw_node.memory
        response_json = self._get_llm_response(raw_memory)
        chat_read_nodes = []
        for memory_i_raw in response_json.get("memory list", []):
            try:
                memory_type = (
                    memory_i_raw.get("memory_type", "LongTermMemory")
                    .replace("长期记忆", "LongTermMemory")
                    .replace("用户记忆", "UserMemory")
                )
                if memory_type not in ["LongTermMemory", "UserMemory"]:
                    memory_type = "LongTermMemory"
                node_i = self._make_memory_item(
                    value=memory_i_raw.get("value", ""),
                    info={
                        "user_id": raw_node.metadata.user_id,
                        "session_id": raw_node.metadata.session_id,
                    },
                    memory_type=memory_type,
                    tags=memory_i_raw.get("tags", [])
                    if isinstance(memory_i_raw.get("tags", []), list)
                    else [],
                    key=memory_i_raw.get("key", ""),
                    sources=raw_node.metadata.sources,
                    background=response_json.get("summary", ""),
                    type_="fact",
                    confidence=0.99,
                )
                chat_read_nodes.append(node_i)
            except Exception as e:
                logger.error(f"[ChatReader] Error parsing memory item: {e}")

        return chat_read_nodes

    def get_scene_data_info(self, scene_data: list, type: str) -> list[list[Any]]:
        """
        Convert normalized MessagesType scenes into scene data info.
        For MultiModelStructMemReader, this is a simplified version that returns the scenes as-is.

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
    ):
        list_scene_data_info = self.get_scene_data_info(messages, type)

        memory_list = []
        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(self._process_multi_model_data, scene_data_info, info, mode=mode)
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
        self, input_memories: list[TextualMemoryItem], type: str
    ) -> list[list[TextualMemoryItem]]:
        if not input_memories:
            return []

        memory_list = []

        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(self._process_transfer_multi_model_data, scene_data_info)
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
