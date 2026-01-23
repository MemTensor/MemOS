from concurrent.futures import as_completed
from typing import Any

from memos.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessageList


logger = get_logger(__name__)


OSS_DIR = "memos/skill_memory/"


def _reconstruct_messages_from_memory_items(memory_items: list[TextualMemoryItem]) -> MessageList:
    pass


def _add_index_to_message(messages: MessageList) -> MessageList:
    pass


def _split_task_chunk_by_llm(messages: MessageList) -> dict[str, MessageList]:
    pass


def _extract_skill_memory_by_llm(task_type: str, messages: MessageList) -> dict[str, Any]:
    pass


def _upload_skills_to_oss(file_path: str) -> str:
    pass


def _delete_skills_from_oss(file_path: str) -> None:
    pass


def _write_skills_to_file(skill_memory: dict[str, Any]) -> str:
    pass


def create_skill_memory_item(skill_memory: dict[str, Any]) -> TextualMemoryItem:
    pass


def process_skill_memory_fine(
    self, fast_memory_items: list[TextualMemoryItem], info: dict[str, Any], **kwargs
) -> list[TextualMemoryItem]:
    messages = _reconstruct_messages_from_memory_items(fast_memory_items)
    messages = _add_index_to_message(messages)

    task_chunks = _split_task_chunk_by_llm(messages)

    skill_memories = []
    with ContextThreadPoolExecutor(max_workers=min(len(task_chunks), 5)) as executor:
        futures = {
            executor.submit(_extract_skill_memory_by_llm, task_type, messages): task_type
            for task_type, messages in task_chunks.items()
        }
        for future in as_completed(futures):
            try:
                skill_memory = future.result()
                skill_memories.append(skill_memory)
            except Exception as e:
                logger.error(f"Error extracting skill memory: {e}")
                continue

    # write skills to file
    file_paths = []
    with ContextThreadPoolExecutor(max_workers=min(len(skill_memories), 5)) as executor:
        futures = {
            executor.submit(_write_skills_to_file, skill_memory): skill_memory
            for skill_memory in skill_memories
        }
        for future in as_completed(futures):
            try:
                file_path = future.result()
                file_paths.append(file_path)
            except Exception as e:
                logger.error(f"Error writing skills to file: {e}")
                continue

    for skill_memory in skill_memories:
        if skill_memory.get("update", False):
            _delete_skills_from_oss()

    urls = []
    for file_path in file_paths:
        # upload skills to oss
        _upload_skills_to_oss(file_path)

    # set urls to skill_memories
    for skill_memory in skill_memories:
        skill_memory["url"] = urls[skill_memory["id"]]

    skill_memory_items = []
    for skill_memory in skill_memories:
        skill_memory_items.append(create_skill_memory_item(skill_memory))

    return skill_memories
