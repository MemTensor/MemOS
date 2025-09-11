from collections.abc import Callable

from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.schemas.general_schemas import (
    ACTIVATION_MEMORY_TYPE,
    ADD_LABEL,
    LONG_TERM_MEMORY_TYPE,
    NOT_INITIALIZED,
    PARAMETER_MEMORY_TYPE,
    QUERY_LABEL,
    TEXT_MEMORY_TYPE,
    USER_INPUT_TYPE,
    WORKING_MEMORY_TYPE,
)
from memos.mem_scheduler.schemas.message_schemas import (
    ScheduleLogForWebItem,
    ScheduleMessageItem,
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
        text_mem_base: TreeTextMemory = mem_cube.text_mem
        current_memory_sizes = text_mem_base.get_current_memory_size()
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

    # TODO: 日志打出来数量不对
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
        memory_type_map = {
            transform_name_to_key(name=m.memory): m.metadata.memory_type
            for m in original_memory + new_memory
        }

        original_text_memories = [m.memory for m in original_memory]
        new_text_memories = [m.memory for m in new_memory]

        # Convert to sets for efficient difference operations
        original_set = set(original_text_memories)
        new_set = set(new_text_memories)

        # Identify changes
        added_memories = list(new_set - original_set)  # Present in new but not original

        # recording messages
        log_messages = []
        for memory in added_memories:
            normalized_mem = transform_name_to_key(name=memory)
            if normalized_mem not in memory_type_map:
                logger.error(f"Memory text not found in type mapping: {memory[:50]}...")
            # Get the memory type from the map, default to LONG_TERM_MEMORY_TYPE if not found
            mem_type = memory_type_map.get(normalized_mem, LONG_TERM_MEMORY_TYPE)

            if mem_type == WORKING_MEMORY_TYPE:
                logger.warning(f"Memory already in working memory: {memory[:50]}...")
                continue

            log_message = self.create_autofilled_log_item(
                log_content=memory,
                label=QUERY_LABEL,
                from_memory_type=mem_type,
                to_memory_type=WORKING_MEMORY_TYPE,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
            log_messages.append(log_message)

        logger.info(
            f"{len(added_memories)} {LONG_TERM_MEMORY_TYPE} memorie(s) "
            f"transformed to {WORKING_MEMORY_TYPE} memories."
        )
        log_func_callback(log_messages)

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

        # Identify changes
        added_memories = list(new_set - original_set)  # Present in new but not original

        # recording messages
        log_messages = []
        for mem in added_memories:
            log_message_a = self.create_autofilled_log_item(
                log_content=mem,
                label=label,
                from_memory_type=TEXT_MEMORY_TYPE,
                to_memory_type=ACTIVATION_MEMORY_TYPE,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
            logger.info(
                f"{len(added_memories)} {TEXT_MEMORY_TYPE} memorie(s) "
                f"transformed to {ACTIVATION_MEMORY_TYPE} memories."
            )

            log_message_b = self.create_autofilled_log_item(
                log_content=mem,
                label=label,
                from_memory_type=ACTIVATION_MEMORY_TYPE,
                to_memory_type=PARAMETER_MEMORY_TYPE,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )

            log_messages.extend([log_message_a, log_message_b])
        logger.info(
            f"{len(added_memories)} {ACTIVATION_MEMORY_TYPE} memorie(s) "
            f"transformed to {PARAMETER_MEMORY_TYPE} memories."
        )
        log_func_callback(log_messages)

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
        """Log changes when working memory is replaced."""
        log_message = self.create_autofilled_log_item(
            log_content=memory,
            label=ADD_LABEL,
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
