import concurrent.futures
import traceback

from typing import Any

from memos import log
from memos.configs.mem_reader import MultiModelStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.mem_reader.read_multi_model import MultiModelParser
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

        # Initialize MultiModelParser for routing to different parsers
        self.multi_model_parser = MultiModelParser(
            embedder=self.embedder,
            llm=self.llm,
            parser=None,
        )

    def _concat_multi_model_memories(
        self, all_memory_items: list[TextualMemoryItem]
    ) -> list[TextualMemoryItem]:
        # TODO: concat multi_model_memories
        return all_memory_items

    @timed
    def _process_multi_model_data(
        self, scene_data_info: MessagesType, info, **kwargs
    ) -> list[TextualMemoryItem]:
        """
        Process multi-model data using MultiModelParser.

        Args:
            scene_data_info: MessagesType input
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters (mode, etc.)
        """
        mode = kwargs.get("mode", "fine")

        # Use MultiModelParser to parse the scene data
        # If it's a list, parse each item; otherwise parse as single message
        if isinstance(scene_data_info, list):
            # Parse each message in the list
            all_memory_items = []
            for msg in scene_data_info:
                items = self.multi_model_parser.parse(msg, info, mode=mode, **kwargs)
                all_memory_items.extend(items)
            fast_memory_items = self._concat_multi_model_memories(all_memory_items)

        else:
            # Parse as single message
            fast_memory_items = self.multi_model_parser.parse(
                scene_data_info, info, mode=mode, **kwargs
            )

        if mode == "fast":
            return fast_memory_items
        else:
            # TODO: parallel call llm and get fine multi model items
            # Part A: call llm
            fine_memory_items = []
            fine_memory_items_string_parser = []
            fine_memory_items.extend(fine_memory_items_string_parser)
            # Part B: get fine multi model items

            for fast_item in fast_memory_items:
                sources = fast_item.metadata.sources
                for source in sources:
                    items = self.multi_model_parser.process_transfer(
                        source, context_items=[fast_item]
                    )
                    fine_memory_items.extend(items)
            logger.warning("Not Implemented Now!")
            return fine_memory_items

    @timed
    def _process_transfer_multi_model_data(
        self, raw_node: TextualMemoryItem
    ) -> list[TextualMemoryItem]:
        sources = raw_node.metadata.sources
        fine_memory_items = []
        for source in sources:
            items = self.multi_model_parser.process_transfer(source, context_items=[raw_node])
            fine_memory_items.extend(items)
        return fine_memory_items

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
    ) -> list[list[TextualMemoryItem]]:
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
