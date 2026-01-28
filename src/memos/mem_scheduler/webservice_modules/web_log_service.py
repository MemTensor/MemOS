from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.general_modules.misc import AutoDroppingQueue as Queue
from memos.mem_scheduler.schemas.general_schemas import DEFAULT_MAX_WEB_LOG_QUEUE_SIZE
from memos.mem_scheduler.schemas.message_schemas import ScheduleLogForWebItem
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    ANSWER_TASK_LABEL,
    MEM_ARCHIVE_TASK_LABEL,
    MEM_ORGANIZE_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)


if TYPE_CHECKING:
    from memos.configs.mem_scheduler import BaseSchedulerConfig

logger = get_logger(__name__)


class WebLogSchedulerModule(BaseSchedulerModule):
    def __init__(self):
        super().__init__()
        self._web_log_message_queue: Queue[ScheduleLogForWebItem] | None = None
        self.max_web_log_queue_size = DEFAULT_MAX_WEB_LOG_QUEUE_SIZE

    def init_web_log_module(self, config: "BaseSchedulerConfig"):
        """Initialize the web log module with the given configuration."""
        self.max_web_log_queue_size = config.get(
            "max_web_log_queue_size", DEFAULT_MAX_WEB_LOG_QUEUE_SIZE
        )
        self._web_log_message_queue = Queue(maxsize=self.max_web_log_queue_size)

    def _submit_web_logs(
        self,
        messages: ScheduleLogForWebItem | list[ScheduleLogForWebItem],
        additional_log_info: str | None = None,
    ) -> None:
        """Submit log messages to the web log queue and optionally to RabbitMQ.

        Args:
            messages: Single log message or list of log messages
        """
        if self._web_log_message_queue is None:
            logger.warning("Web log queue is not initialized. Dropping logs.")
            return

        if isinstance(messages, ScheduleLogForWebItem):
            messages = [messages]  # transform single message to list

        for message in messages:
            # Check if rabbitmq_config is available (provided by RabbitMQSchedulerModule)
            if getattr(self, "rabbitmq_config", None) is None:
                continue
            try:
                # Always call publish; the publisher now caches when offline and flushes after reconnect
                logger.info(
                    f"[DIAGNOSTIC] base_scheduler._submit_web_logs: enqueue publish {message.model_dump_json(indent=2)}"
                )
                # Assumes rabbitmq_publish_message is available via mixin
                if hasattr(self, "rabbitmq_publish_message"):
                    self.rabbitmq_publish_message(message=message.to_dict())
                else:
                    logger.warning("rabbitmq_publish_message method not found.")

                logger.info(
                    "[DIAGNOSTIC] base_scheduler._submit_web_logs: publish dispatched "
                    "item_id=%s task_id=%s label=%s",
                    message.item_id,
                    message.task_id,
                    message.label,
                )
            except Exception as e:
                logger.error(
                    f"[DIAGNOSTIC] base_scheduler._submit_web_logs failed: {e}", exc_info=True
                )

        logger.debug(
            f"{len(messages)} submitted. {self._web_log_message_queue.qsize()} in queue. additional_log_info: {additional_log_info}"
        )

    def get_web_log_messages(self) -> list[dict]:
        """
        Retrieve structured log messages from the queue and return JSON-serializable dicts.
        """
        if self._web_log_message_queue is None:
            return []

        raw_items: list[ScheduleLogForWebItem] = []
        while True:
            try:
                raw_items.append(self._web_log_message_queue.get_nowait())
            except Exception:
                break

        def _map_label(label: str) -> str:
            mapping = {
                QUERY_TASK_LABEL: "addMessage",
                ANSWER_TASK_LABEL: "addMessage",
                ADD_TASK_LABEL: "addMemory",
                MEM_UPDATE_TASK_LABEL: "updateMemory",
                MEM_ORGANIZE_TASK_LABEL: "mergeMemory",
                MEM_ARCHIVE_TASK_LABEL: "archiveMemory",
            }
            return mapping.get(label, label)

        def _normalize_item(item: ScheduleLogForWebItem) -> dict:
            data = item.to_dict()
            data["label"] = _map_label(data.get("label"))
            memcube_content = getattr(item, "memcube_log_content", None) or []
            metadata = getattr(item, "metadata", None) or []

            memcube_name = getattr(item, "memcube_name", None)
            if not memcube_name and hasattr(self, "_map_memcube_name"):
                # _map_memcube_name is provided by SchedulerLoggerModule
                memcube_name = self._map_memcube_name(item.mem_cube_id)
            data["memcube_name"] = memcube_name

            memory_len = getattr(item, "memory_len", None)
            if memory_len is None:
                if data["label"] == "mergeMemory":
                    memory_len = len([c for c in memcube_content if c.get("type") != "postMerge"])
                elif memcube_content:
                    memory_len = len(memcube_content)
                else:
                    memory_len = 1 if item.log_content else 0

            data["memcube_log_content"] = memcube_content
            data["memory_len"] = memory_len

            def _with_memory_time(meta: dict) -> dict:
                enriched = dict(meta)
                if "memory_time" not in enriched:
                    enriched["memory_time"] = enriched.get("updated_at") or enriched.get(
                        "update_at"
                    )
                return enriched

            data["metadata"] = [_with_memory_time(m) for m in metadata]
            data["log_title"] = ""
            return data

        return [_normalize_item(it) for it in raw_items]
