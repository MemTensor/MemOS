import hashlib

from collections.abc import Callable

from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.schemas.general_schemas import (
    ACTIVATION_MEMORY_TYPE,
    NOT_INITIALIZED,
    PARAMETER_MEMORY_TYPE,
    TEXT_MEMORY_TYPE,
    WORKING_MEMORY_TYPE,
)
from memos.mem_scheduler.schemas.message_schemas import (
    ScheduleLogForWebItem,
    ScheduleMessageItem,
)
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    MEM_ARCHIVE_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.utils.filter_utils import (
    transform_name_to_key,
)
from memos.mem_scheduler.utils.misc_utils import log_exceptions
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


logger = get_logger(__name__)


class SchedulerLoggerModule(BaseSchedulerModule):
    def __init__(self):
        """
        Initialize RabbitMQ connection settings.
        """
        super().__init__()

    @log_exceptions(logger=logger)
    def create_autofilled_log_item(
        self,
        log_content: str,
        label: str,
        from_memory_type: str,
        to_memory_type: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
    ) -> ScheduleLogForWebItem:
        if mem_cube is None:
            logger.error(
                "mem_cube is None — this should not happen in production!", stack_info=True
            )
        text_mem_base: TreeTextMemory = mem_cube.text_mem
        current_memory_sizes = text_mem_base.get_current_memory_size(user_name=mem_cube_id)
        current_memory_sizes = {
            "long_term_memory_size": current_memory_sizes.get("LongTermMemory", 0),
            "user_memory_size": current_memory_sizes.get("UserMemory", 0),
            "working_memory_size": current_memory_sizes.get("WorkingMemory", 0),
            "transformed_act_memory_size": NOT_INITIALIZED,
            "parameter_memory_size": NOT_INITIALIZED,
        }
        memory_capacities = {
            "long_term_memory_capacity": text_mem_base.memory_manager.memory_size["LongTermMemory"],
            "user_memory_capacity": text_mem_base.memory_manager.memory_size["UserMemory"],
            "working_memory_capacity": text_mem_base.memory_manager.memory_size["WorkingMemory"],
            "transformed_act_memory_capacity": NOT_INITIALIZED,
            "parameter_memory_capacity": NOT_INITIALIZED,
        }

        if hasattr(self, "monitor"):
            if (
                user_id in self.monitor.activation_memory_monitors
                and mem_cube_id in self.monitor.activation_memory_monitors[user_id]
            ):
                activation_monitor = self.monitor.activation_memory_monitors[user_id][mem_cube_id]
                transformed_act_memory_size = len(activation_monitor.obj.memories)
                logger.info(
                    f'activation_memory_monitors currently has "{transformed_act_memory_size}" transformed memory size'
                )
            else:
                transformed_act_memory_size = 0
                logger.info(
                    f'activation_memory_monitors is not initialized for user "{user_id}" and mem_cube "{mem_cube_id}'
                )
            current_memory_sizes["transformed_act_memory_size"] = transformed_act_memory_size
            current_memory_sizes["parameter_memory_size"] = 1

            memory_capacities["transformed_act_memory_capacity"] = (
                self.monitor.activation_mem_monitor_capacity
            )
            memory_capacities["parameter_memory_capacity"] = 1

        log_message = ScheduleLogForWebItem(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            label=label,
            from_memory_type=from_memory_type,
            to_memory_type=to_memory_type,
            log_content=log_content,
            current_memory_sizes=current_memory_sizes,
            memory_capacities=memory_capacities,
        )
        return log_message

    @log_exceptions(logger=logger)
    def create_event_log(
        self,
        label: str,
        from_memory_type: str,
        to_memory_type: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        memcube_log_content: list[dict],
        metadata: list[dict],
        memory_len: int,
        memcube_name: str | None = None,
        log_content: str | None = None,
    ) -> ScheduleLogForWebItem:
        item = self.create_autofilled_log_item(
            log_content=log_content or "",
            label=label,
            from_memory_type=from_memory_type,
            to_memory_type=to_memory_type,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
        )
        item.memcube_log_content = memcube_log_content
        item.metadata = metadata
        item.memory_len = memory_len
        item.memcube_name = memcube_name or self._map_memcube_name(mem_cube_id)
        return item

    def _map_memcube_name(self, mem_cube_id: str) -> str:
        x = mem_cube_id or ""
        if "public" in x.lower():
            return "PublicMemCube"
        return "UserMemCube"

    # TODO: Log output count is incorrect
    @log_exceptions(logger=logger)
    def log_working_memory_replacement(
        self,
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        log_func_callback: Callable[[list[ScheduleLogForWebItem]], None],
    ):
        """Log changes when working memory is replaced."""
        original_text_memories = [m.memory for m in original_memory]
        new_text_memories = [m.memory for m in new_memory]
        original_set = set(original_text_memories)
        new_set = set(new_text_memories)
        added_texts = []
        for new_mem in new_set:
            if new_mem not in original_set:
                added_texts.append(new_mem)
        memcube_content = []
        meta = []
        by_text = {m.memory: m for m in new_memory}
        for t in added_texts:
            itm = by_text.get(t)
            if not itm:
                continue
            key_name = getattr(itm.metadata, "key", None) or itm.memory
            k = transform_name_to_key(name=key_name)
            memcube_content.append(
                {
                    "content": f"[{itm.metadata.memory_type}→{WORKING_MEMORY_TYPE}] {k}: {itm.memory}",
                    "ref_id": itm.id,
                }
            )
            meta.append(
                {
                    "ref_id": itm.id,
                    "id": itm.id,
                    "key": itm.metadata.key,
                    "memory": itm.memory,
                    "memory_type": itm.metadata.memory_type,
                    "status": itm.metadata.status,
                    "confidence": itm.metadata.confidence,
                    "tags": itm.metadata.tags,
                    "updated_at": getattr(itm.metadata, "updated_at", None)
                    or getattr(itm.metadata, "update_at", None),
                }
            )
        # Only create log if there are actual memory changes
        if memcube_content:
            ev = self.create_event_log(
                label="scheduleMemory",
                from_memory_type=TEXT_MEMORY_TYPE,
                to_memory_type=WORKING_MEMORY_TYPE,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                memcube_log_content=memcube_content,
                metadata=meta,
                memory_len=len(memcube_content),
                memcube_name=self._map_memcube_name(mem_cube_id),
            )
            log_func_callback([ev])

    @log_exceptions(logger=logger)
    def log_activation_memory_update(
        self,
        original_text_memories: list[str],
        new_text_memories: list[str],
        label: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        log_func_callback: Callable[[list[ScheduleLogForWebItem]], None],
    ):
        """Log changes when activation memory is updated."""
        original_set = set(original_text_memories)
        new_set = set(new_text_memories)

        added_memories = list(new_set - original_set)
        memcube_content = []
        meta = []
        for mem in added_memories:
            key = transform_name_to_key(mem)
            ref_id = f"actparam-{hashlib.md5(mem.encode()).hexdigest()}"
            memcube_content.append(
                {
                    "content": f"[{ACTIVATION_MEMORY_TYPE}→{PARAMETER_MEMORY_TYPE}] {key}: {mem}",
                    "ref_id": ref_id,
                }
            )
            meta.append(
                {
                    "ref_id": ref_id,
                    "id": ref_id,
                    "key": key,
                    "memory": mem,
                    "memory_type": ACTIVATION_MEMORY_TYPE,
                    "status": None,
                    "confidence": None,
                    "tags": None,
                    "updated_at": None,
                }
            )
        # Only create log if there are actual memory changes
        if memcube_content:
            ev = self.create_event_log(
                label="scheduleMemory",
                from_memory_type=ACTIVATION_MEMORY_TYPE,
                to_memory_type=PARAMETER_MEMORY_TYPE,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                memcube_log_content=memcube_content,
                metadata=meta,
                memory_len=len(added_memories),
                memcube_name=self._map_memcube_name(mem_cube_id),
            )
            log_func_callback([ev])

    @log_exceptions(logger=logger)
    def log_adding_memory(
        self,
        memory: str,
        memory_type: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        log_func_callback: Callable[[list[ScheduleLogForWebItem]], None],
    ):
        """Deprecated: legacy text log. Use create_event_log with structured fields instead."""
        log_message = self.create_autofilled_log_item(
            log_content=memory,
            label=ADD_TASK_LABEL,
            from_memory_type=USER_INPUT_TYPE,
            to_memory_type=memory_type,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
        )
        log_func_callback([log_message])
        logger.info(
            f"{USER_INPUT_TYPE} memory for user {user_id} "
            f"converted to {memory_type} memory in mem_cube {mem_cube_id}: {memory}"
        )

    @log_exceptions(logger=logger)
    def log_updating_memory(
        self,
        memory: str,
        memory_type: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        log_func_callback: Callable[[list[ScheduleLogForWebItem]], None],
    ):
        """Deprecated: legacy text log. Use create_event_log with structured fields instead."""
        log_message = self.create_autofilled_log_item(
            log_content=memory,
            label=MEM_UPDATE_TASK_LABEL,
            from_memory_type=memory_type,
            to_memory_type=memory_type,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
        )
        log_func_callback([log_message])

    @log_exceptions(logger=logger)
    def log_archiving_memory(
        self,
        memory: str,
        memory_type: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        log_func_callback: Callable[[list[ScheduleLogForWebItem]], None],
    ):
        """Deprecated: legacy text log. Use create_event_log with structured fields instead."""
        log_message = self.create_autofilled_log_item(
            log_content=memory,
            label=MEM_ARCHIVE_TASK_LABEL,
            from_memory_type=memory_type,
            to_memory_type=memory_type,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
        )
        log_func_callback([log_message])

    @log_exceptions(logger=logger)
    def validate_schedule_message(self, message: ScheduleMessageItem, label: str):
        """Validate if the message matches the expected label.

        Args:
            message: Incoming message item to validate.
            label: Expected message label (e.g., QUERY_LABEL/ANSWER_LABEL).

        Returns:
            bool: True if validation passed, False otherwise.
        """
        if message.label != label:
            logger.error(f"Handler validation failed: expected={label}, actual={message.label}")
            return False
        return True

    @log_exceptions(logger=logger)
    def validate_schedule_messages(self, messages: list[ScheduleMessageItem], label: str):
        """Validate if all messages match the expected label.

        Args:
            messages: List of message items to validate.
            label: Expected message label (e.g., QUERY_LABEL/ANSWER_LABEL).

        Returns:
            bool: True if all messages passed validation, False if any failed.
        """
        for message in messages:
            if not self.validate_schedule_message(message, label):
                logger.error("Message batch contains invalid labels, aborting processing")
                return False
        return True
