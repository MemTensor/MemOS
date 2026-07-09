from __future__ import annotations

import json
import threading

from typing import TYPE_CHECKING, ClassVar

from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import MEM_DREAM_TASK_LABEL
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.plugins.hook_defs import H
from memos.plugins.hooks import trigger_single_hook


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


logger = get_logger(__name__)


class MemDreamMessageHandler(BaseSchedulerHandler):
    """Thin scheduler entrypoint for Dream tasks.

    The handler intentionally contains no Dream business logic. Its job is only to:
    1. collect a scheduler batch into a single snapshot payload,
    2. guard concurrent execution with a per-cube single-flight lock, and
    3. delegate the real work to the currently active Dream plugin.
    """

    _dream_locks: ClassVar[dict[str, threading.Lock]] = {}
    _class_lock: ClassVar[threading.Lock] = threading.Lock()

    @property
    def expected_task_label(self) -> str:
        return MEM_DREAM_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        mem_cube = self.scheduler_context.get_mem_cube()
        if mem_cube is None:
            logger.warning(
                "mem_cube is None for user_id=%s, mem_cube_id=%s, skipping dream",
                user_id,
                mem_cube_id,
            )
            return

        text_mem = getattr(mem_cube, "text_mem", None)
        if text_mem is None:
            logger.warning(
                "text_mem is unavailable for user_id=%s, mem_cube_id=%s, skipping dream",
                user_id,
                mem_cube_id,
            )
            return

        user_name = ""
        for msg in batch:
            user_name = msg.user_name or user_name

        signal_snapshot = self._build_signal_snapshot(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            user_name=user_name,
            batch=batch,
        )
        self._run_dream(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            user_name=user_name,
            signal_snapshot=signal_snapshot,
            text_mem=text_mem,
        )

    @classmethod
    def _get_dream_lock(cls, mem_cube_id: str) -> threading.Lock:
        with cls._class_lock:
            lock = cls._dream_locks.get(mem_cube_id)
            if lock is None:
                lock = threading.Lock()
                cls._dream_locks[mem_cube_id] = lock
            return lock

    def _build_signal_snapshot(
        self,
        *,
        user_id: str,
        mem_cube_id: str,
        user_name: str,
        batch: list[ScheduleMessageItem],
    ):
        from memos.dream.types import DreamSignalSnapshot

        # The framework accepts batched Dream tasks, but the scaffold only needs
        # a single normalized snapshot object. The most recent non-empty payload wins.
        snapshot = DreamSignalSnapshot(
            mem_cube_id=mem_cube_id,
            user_id=user_id,
            user_name=user_name,
        )
        for msg in batch:
            if not msg.content:
                continue
            try:
                payload = json.loads(msg.content)
            except json.JSONDecodeError:
                logger.warning(
                    "Invalid dream payload for mem_cube_id=%s, item_id=%s; ignore batch item",
                    mem_cube_id,
                    msg.item_id,
                )
                continue
            try:
                snapshot = DreamSignalSnapshot.model_validate(payload)
            except Exception:
                logger.warning(
                    "Dream payload schema mismatch for mem_cube_id=%s, item_id=%s; ignore batch item",
                    mem_cube_id,
                    msg.item_id,
                    exc_info=True,
                )
        return snapshot

    def _run_dream(
        self,
        *,
        user_id: str,
        mem_cube_id: str,
        user_name: str,
        signal_snapshot,
        text_mem,
    ) -> None:
        lock = self._get_dream_lock(mem_cube_id)
        if not lock.acquire(blocking=False):
            logger.info(
                "[Dream] Already running for mem_cube_id=%s; skip this trigger.",
                mem_cube_id,
            )
            return

        try:
            # The active Dream plugin owns the pipeline. The scheduler only forwards
            # the normalized execution context through a single-provider hook.
            trigger_single_hook(
                H.DREAM_EXECUTE,
                mem_cube_id=mem_cube_id,
                user_id=user_id,
                user_name=user_name,
                signal_snapshot=signal_snapshot,
                text_mem=text_mem,
                scheduler_context=self.scheduler_context,
            )
        finally:
            lock.release()
