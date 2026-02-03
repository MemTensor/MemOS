from __future__ import annotations

from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleLogForWebItem
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    ANSWER_TASK_LABEL,
    MEM_ARCHIVE_TASK_LABEL,
    MEM_ORGANIZE_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)


logger = get_logger(__name__)


class BaseSchedulerWebLogMixin:
    def _submit_web_logs(
        self,
        messages: ScheduleLogForWebItem | list[ScheduleLogForWebItem],
        additional_log_info: str | None = None,
    ) -> None:
        if isinstance(messages, ScheduleLogForWebItem):
            messages = [messages]

        for message in messages:
            if self.rabbitmq_config is None:
                return
            try:
                logger.info(
                    "[DIAGNOSTIC] base_scheduler._submit_web_logs: enqueue publish %s",
                    message.model_dump_json(indent=2),
                )
                self.rabbitmq_publish_message(message=message.to_dict())
                logger.info(
                    "[DIAGNOSTIC] base_scheduler._submit_web_logs: publish dispatched item_id=%s task_id=%s label=%s",
                    message.item_id,
                    message.task_id,
                    message.label,
                )
            except Exception as e:
                logger.error(
                    "[DIAGNOSTIC] base_scheduler._submit_web_logs failed: %s",
                    e,
                    exc_info=True,
                )

        logger.debug(
            "%s submitted. %s in queue. additional_log_info: %s",
            len(messages),
            self._web_log_message_queue.qsize(),
            additional_log_info,
        )

    def get_web_log_messages(self) -> list[dict]:
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
                    enriched["memory_time"] = enriched.get("updated_at") or enriched.get("update_at")
                return enriched

            data["metadata"] = [_with_memory_time(m) for m in metadata]
            data["log_title"] = ""
            return data

        return [_normalize_item(it) for it in raw_items]
