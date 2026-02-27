from collections.abc import Callable
from datetime import datetime

from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.monitors.general_monitor import SchedulerGeneralMonitor
from memos.mem_scheduler.utils.db_utils import get_utc_now
from memos.memories.activation.kv import KVCacheMemory
from memos.memories.activation.vllmkv import VLLMKVCacheItem, VLLMKVCacheMemory
from memos.memories.textual.tree import TextualMemoryItem
from memos.templates.mem_scheduler_prompts import MEMORY_ASSEMBLY_TEMPLATE
from memos.types.general_types import MemCubeID, UserID


logger = get_logger(__name__)


class ActivationMemoryManager:
    def __init__(
        self,
        act_mem_dump_path: str,
        monitor: SchedulerGeneralMonitor,
        log_func_callback: Callable,
        log_activation_memory_update_func: Callable,
    ):
        self.act_mem_dump_path = act_mem_dump_path
        self.monitor = monitor
        self.log_func_callback = log_func_callback
        self.log_activation_memory_update_func = log_activation_memory_update_func

    def update_activation_memory(
        self,
        new_memories: list[str | TextualMemoryItem],
        label: str,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube: GeneralMemCube,
    ) -> None:
        """
        Update activation memory by extracting KVCacheItems from new_memory (list of str),
        add them to a KVCacheMemory instance, and dump to disk.
        """
        if len(new_memories) == 0:
            logger.error("update_activation_memory: new_memory is empty.")
            return
        if isinstance(new_memories[0], TextualMemoryItem):
            new_text_memories = [mem.memory for mem in new_memories]
        elif isinstance(new_memories[0], str):
            new_text_memories = new_memories
        else:
            logger.error("Not Implemented.")
            return

        try:
            if isinstance(mem_cube.act_mem, VLLMKVCacheMemory):
                act_mem: VLLMKVCacheMemory = mem_cube.act_mem
            elif isinstance(mem_cube.act_mem, KVCacheMemory):
                act_mem: KVCacheMemory = mem_cube.act_mem
            else:
                logger.error("Not Implemented.")
                return

            new_text_memory = MEMORY_ASSEMBLY_TEMPLATE.format(
                memory_text="".join(
                    [
                        f"{i + 1}. {sentence.strip()}\n"
                        for i, sentence in enumerate(new_text_memories)
                        if sentence.strip()  # Skip empty strings
                    ]
                )
            )

            # huggingface or vllm kv cache
            original_cache_items: list[VLLMKVCacheItem] = act_mem.get_all()
            original_text_memories = []
            if len(original_cache_items) > 0:
                pre_cache_item: VLLMKVCacheItem = original_cache_items[-1]
                original_text_memories = pre_cache_item.records.text_memories
                original_composed_text_memory = pre_cache_item.records.composed_text_memory
                if original_composed_text_memory == new_text_memory:
                    logger.warning(
                        "Skipping memory update - new composition matches existing cache: %s",
                        new_text_memory[:50] + "..."
                        if len(new_text_memory) > 50
                        else new_text_memory,
                    )
                    return
                act_mem.delete_all()

            cache_item = act_mem.extract(new_text_memory)
            cache_item.records.text_memories = new_text_memories
            cache_item.records.timestamp = get_utc_now()

            act_mem.add([cache_item])
            act_mem.dump(self.act_mem_dump_path)

            self.log_activation_memory_update_func(
                original_text_memories=original_text_memories,
                new_text_memories=new_text_memories,
                label=label,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                log_func_callback=self.log_func_callback,
            )

        except Exception as e:
            logger.error(f"MOS-based activation memory update failed: {e}", exc_info=True)
            # Re-raise the exception if it's critical for the operation
            # For now, we'll continue execution but this should be reviewed

    def update_activation_memory_periodically(
        self,
        interval_seconds: int,
        label: str,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube: GeneralMemCube,
    ):
        try:
            if (
                self.monitor.last_activation_mem_update_time == datetime.min
                or self.monitor.timed_trigger(
                    last_time=self.monitor.last_activation_mem_update_time,
                    interval_seconds=interval_seconds,
                )
            ):
                logger.info(
                    f"Updating activation memory for user {user_id} and mem_cube {mem_cube_id}"
                )

                if (
                    user_id not in self.monitor.working_memory_monitors
                    or mem_cube_id not in self.monitor.working_memory_monitors[user_id]
                    or len(self.monitor.working_memory_monitors[user_id][mem_cube_id].obj.memories)
                    == 0
                ):
                    logger.warning(
                        "No memories found in working_memory_monitors, activation memory update is skipped"
                    )
                    return

                self.monitor.update_activation_memory_monitors(
                    user_id=user_id, mem_cube_id=mem_cube_id, mem_cube=mem_cube
                )

                # Sync with database to get latest activation memories
                activation_db_manager = self.monitor.activation_memory_monitors[user_id][
                    mem_cube_id
                ]
                activation_db_manager.sync_with_orm()
                new_activation_memories = [
                    m.memory_text for m in activation_db_manager.obj.memories
                ]

                logger.info(
                    f"Collected {len(new_activation_memories)} new memory entries for processing"
                )
                # Print the content of each new activation memory
                for i, memory in enumerate(new_activation_memories[:5], 1):
                    logger.info(
                        f"Part of New Activation Memorires | {i}/{len(new_activation_memories)}: {memory[:20]}"
                    )

                self.update_activation_memory(
                    new_memories=new_activation_memories,
                    label=label,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                )

                self.monitor.last_activation_mem_update_time = get_utc_now()

                logger.debug(
                    f"Activation memory update completed at {self.monitor.last_activation_mem_update_time}"
                )

            else:
                logger.info(
                    f"Skipping update - {interval_seconds} second interval not yet reached. "
                    f"Last update time is {self.monitor.last_activation_mem_update_time} and now is "
                    f"{get_utc_now()}"
                )
        except Exception as e:
            logger.error(f"Error in update_activation_memory_periodically: {e}", exc_info=True)
