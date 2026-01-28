from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from sqlalchemy.engine import Engine

    from memos.configs.mem_scheduler import GeneralSchedulerConfig
    from memos.mem_cube.general import GeneralMemCube
    from memos.mem_feedback.simple_feedback import SimpleMemFeedback
    from memos.mem_scheduler.general_scheduler import GeneralScheduler
    from memos.mem_scheduler.memory_manage_modules.retriever import SchedulerRetriever
    from memos.mem_scheduler.monitors.general_monitor import SchedulerGeneralMonitor
    from memos.mem_scheduler.schemas.message_schemas import (
        ScheduleLogForWebItem,
        ScheduleMessageItem,
    )
    from memos.mem_scheduler.task_schedule_modules.dispatcher import SchedulerDispatcher


class SchedulerContext:
    """Context object to hold dependencies for handlers."""

    def __init__(self, scheduler: "GeneralScheduler"):
        self._scheduler = scheduler

    @property
    def mem_cube(self) -> "GeneralMemCube":
        return self._scheduler.mem_cube

    @property
    def monitor(self) -> "SchedulerGeneralMonitor":
        return self._scheduler.monitor

    @property
    def retriever(self) -> "SchedulerRetriever":
        return self._scheduler.retriever

    @property
    def config(self) -> "GeneralSchedulerConfig":
        return self._scheduler.config

    @property
    def dispatcher(self) -> "SchedulerDispatcher":
        return self._scheduler.dispatcher

    @property
    def db_engine(self) -> "Engine | None":
        return self._scheduler.db_engine

    @property
    def feedback_server(self) -> "SimpleMemFeedback | None":
        return self._scheduler.feedback_server

    @property
    def mem_reader(self) -> Any:
        return self._scheduler.mem_reader

    # Methods
    def submit_web_logs(self, messages: list["ScheduleLogForWebItem"]) -> None:
        self._scheduler._submit_web_logs(messages)

    def create_event_log(self, *args, **kwargs) -> "ScheduleLogForWebItem":
        return self._scheduler.create_event_log(*args, **kwargs)

    def validate_schedule_messages(self, messages: list["ScheduleMessageItem"], label: str) -> bool:
        return self._scheduler.validate_schedule_messages(messages, label)

    def submit_messages(self, messages: list["ScheduleMessageItem"]) -> None:
        self._scheduler.submit_messages(messages)

    def long_memory_update_process(self, *args, **kwargs) -> None:
        self._scheduler.long_memory_update_process(*args, **kwargs)

    def process_session_turn(self, *args, **kwargs) -> Any:
        return self._scheduler.process_session_turn(*args, **kwargs)

    def replace_working_memory(self, *args, **kwargs) -> Any:
        return self._scheduler.replace_working_memory(*args, **kwargs)

    def update_activation_memory_periodically(self, *args, **kwargs) -> None:
        self._scheduler.update_activation_memory_periodically(*args, **kwargs)

    def map_memcube_name(self, mem_cube_id: str) -> str:
        return self._scheduler._map_memcube_name(mem_cube_id)

    def log_add_messages(self, *args, **kwargs) -> Any:
        return self._scheduler.log_add_messages(*args, **kwargs)

    def send_add_log_messages_to_cloud_env(self, *args, **kwargs) -> None:
        self._scheduler.send_add_log_messages_to_cloud_env(*args, **kwargs)

    def send_add_log_messages_to_local_env(self, *args, **kwargs) -> None:
        self._scheduler.send_add_log_messages_to_local_env(*args, **kwargs)

    def process_memories_with_reader(self, *args, **kwargs) -> None:
        self._scheduler._process_memories_with_reader(*args, **kwargs)

    def process_memories_with_reorganize(self, *args, **kwargs) -> None:
        self._scheduler._process_memories_with_reorganize(*args, **kwargs)
