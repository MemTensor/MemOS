"""Orchestrate durable Episodes with the MemOS scheduler."""

from __future__ import annotations

import json
import os
import threading
import time

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_RESULT_TASK_LABEL as MERGE_RESULT,
)
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_TASK_LABEL as MERGE,
)
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_PROCESS_TASK_LABEL as PROCESS,
)
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_SPACE_TASK_LABEL as SPACE,
)
from memos.mem_scheduler.schemas.task_schemas import (
    SCHEDULER_DEFERRED_INFO_KEY,
    SCHEDULER_SKIP_ACK_INFO_KEY,
)

from .add_acceptance import AddAcceptance
from .add_algorithm import organize_episode, recall_candidates
from .add_commit import DraftWitnessError, EpisodeFenceError, commit_changeset
from .add_dispatch import EpisodeDispatch, StageLease, label_for
from .add_evidence import anchor_keys, collect_anchors
from .add_extraction import extract_episode, jsonable
from .add_index import index_changeset, ranked_topics
from .add_merge import VersionConflictError, prepare_merge, rebase_append_only, rewrite_metadata
from .judge import ModelError


if TYPE_CHECKING:
    from collections.abc import Callable

    from .add_store import PostgresAddStore
    from .judge import ModelHub

logger = get_logger(__name__)
_RELEASE_LOCK = """
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0
"""
_RENEW_LOCK = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
"""


@dataclass(frozen=True)
class RuntimeSettings:
    sync_wait_seconds: float = 30.0
    scan_seconds: int = 60
    recover_seconds: float = 1.0
    publish_stale_seconds: int = 60
    stage_lease_seconds: int = 600
    formation_count: int = 10
    formation_interval: int = 7200
    input_budget: int = 12_000
    lock_wait_seconds: int = 900
    previous_wait_seconds: int = 600

    @classmethod
    def from_env(cls) -> RuntimeSettings:
        return cls(
            **{
                name: type(default)(os.getenv(f"PROJECT_MEMORY_{name.upper()}", str(default)))
                for name, default in vars(cls()).items()
            }
        )

    def __post_init__(self) -> None:
        if min(vars(self).values()) <= 0:
            raise ValueError("Project memory runtime limits must be positive")


class EpisodeAddRuntime:
    def __init__(
        self,
        store: PostgresAddStore,
        hub: ModelHub,
        submit: Callable[[list[ScheduleMessageItem]], None],
        redis: Any,
        settings: RuntimeSettings | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
        embedder: Callable[[list[str]], list[list[float]]] | None = None,
        legacy_status: Callable[[str, str], dict | None] | None = None,
        embedding_model_id: str | None = None,
    ) -> None:
        self.store = store
        self.hub = hub
        self.submit = submit
        self.redis = redis
        self.settings = settings or RuntimeSettings.from_env()
        self.now = clock or (lambda: datetime.now(timezone.utc))
        self.embedder = embedder
        self.legacy_status = legacy_status
        self.embedding_model_id = embedding_model_id
        self.acceptance = AddAcceptance(
            store, clock=self.now, anchor_collector=collect_anchors, anchor_keyer=anchor_keys
        )
        self.dispatch = EpisodeDispatch(store, lease_seconds=self.settings.stage_lease_seconds)
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    def accept(self, request: Any) -> dict[str, Any]:
        accepted = self.acceptance.accept(request)
        for episode_id in accepted.closed_episode_ids:
            self._publish(episode_id)
        status = "running"
        error = None
        if getattr(request, "async_mode", "async") == "sync":
            deadline = time.monotonic() + self.settings.sync_wait_seconds
            while True:
                outcomes = [self.store.load_episode(eid) for eid in accepted.closed_episode_ids]
                if all(row is None or row["outcome"] != "pending" for row in outcomes):
                    error = next((row["error"] for row in outcomes if row and row["error"]), None)
                    status = (
                        "failed"
                        if any(row and row["outcome"] == "failed" for row in outcomes)
                        else "completed"
                    )
                    if accepted.duplicate:
                        existing = self.status(accepted.task_id, request.user_id) or {}
                        status = existing.get("status", "completed")
                        if status == "in_progress":
                            status = "running"
                        error = (existing.get("memory_views") or {}).get("project", {}).get("error")
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(0.1, remaining))

        result = {
            "success": status != "failed",
            "task_id": accepted.task_id,
            "status": status,
            "memory_view": "project",
            "_duplicate": accepted.duplicate,
        }
        if error:
            result["error"] = error
        return result

    def status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        current = self.acceptance.status(task_id, user_id)
        old = self.legacy_status(task_id, user_id) if self.legacy_status else None
        if current is None:
            return old
        if old:
            views = current["memory_views"]
            project = views["project"]
            historical = old["memory_views"]["project"]["memory_ids"]
            project["memory_ids"] = sorted(set(project["memory_ids"]).union(historical))
            views["updated"] = len(project["memory_ids"])
        return current

    def _publish(self, episode_id: str) -> None:
        try:
            episode = self.store.load_episode(episode_id)
            if episode is None:
                return
            label = label_for(episode)
            if label is None or not episode["owner_task_id"]:
                return
            now = self.now()
            if episode["next_retry_at"] is not None and episode["next_retry_at"] > now:
                return
            data = episode["organize_result"] or {}
            payload = {"episode_id": episode_id, "attempt": episode["attempt"]}
            if label in {MERGE, MERGE_RESULT}:
                payload["lock_token"] = data.get("lock_token")
            if label == MERGE:
                payload["plan"] = data["plan"]
            if label == MERGE_RESULT:
                payload["status"] = "prepared"
                payload["changeset"] = data["changeset"]
            self.submit(
                [
                    ScheduleMessageItem(
                        user_id=episode["user_id"],
                        mem_cube_id=episode["space_id"],
                        task_id=episode["owner_task_id"],
                        label=label,
                        content=json.dumps(jsonable(payload), ensure_ascii=False),
                    )
                ]
            )
            self.dispatch.published(episode, now)
        except Exception as exc:
            logger.warning(
                "Project Add will recover publication for %s (%s)", episode_id, type(exc).__name__
            )

    def recover(self) -> None:
        for episode in self.dispatch.due(
            self.now(), stale_seconds=self.settings.publish_stale_seconds
        ):
            self._publish(episode["id"])

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stopped.clear()
        self._thread = threading.Thread(
            target=self._run_timer, name="project-add-recovery", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

    def _run_timer(self) -> None:
        # One scanner per schema: the due scan covers every project stored in it.
        scan_key = f"project_episode_scan_lock:{self.store.schema_name}"
        next_close = 0.0
        while not self._stopped.is_set():
            try:
                if time.monotonic() >= next_close:
                    token = uuid4().hex
                    if self.redis.set(
                        scan_key, token, nx=True, ex=min(50, self.settings.scan_seconds)
                    ):
                        try:
                            self.acceptance.close_due()
                        finally:
                            self.redis.eval(_RELEASE_LOCK, 1, scan_key, token)
                    next_close = time.monotonic() + self.settings.scan_seconds
                self.recover()
            except Exception as exc:
                logger.warning("Project Add timer will retry (%s)", type(exc).__name__)
            self._stopped.wait(self.settings.recover_seconds)

    def handle(self, batch: list[ScheduleMessageItem]) -> None:
        for message in batch:
            try:
                lease = self.dispatch.claim(message, self.now())
                if lease is not None:
                    self._work(lease, message.label)
            except Exception as exc:
                message.info = {
                    **(message.info or {}),
                    SCHEDULER_DEFERRED_INFO_KEY: True,
                    SCHEDULER_SKIP_ACK_INFO_KEY: True,
                }
                logger.warning(
                    "Project Add kept %s delivery pending (%s)", message.label, type(exc).__name__
                )

    def _work(self, lease: StageLease, label: str) -> None:
        episode = self.store.load_episode(lease.episode_id)
        if episode is None:
            return
        try:
            if label == PROCESS:
                self._extract(lease, episode)
            elif label == SPACE:
                self._organize(lease, episode)
            elif label == MERGE:
                self._merge(lease, episode)
            else:
                self._commit(lease, episode)
        except EpisodeFenceError:
            self._terminal(lease, episode, "SPACE_CLEARED", "The Episode's Space or lease changed")
        except DraftWitnessError:
            self._terminal(
                lease, episode, "INVALID_EVIDENCE", "A Draft has invalid source evidence"
            )
        except VersionConflictError:
            self._conflict(lease, episode)
        except Exception as exc:
            if label == MERGE_RESULT and self._committed(lease):
                self._release(episode, lease.data.get("lock_token"))
                return
            reason = "MODEL_UNAVAILABLE" if isinstance(exc, ModelError) else "STORE_UNAVAILABLE"
            logger.warning("Project Add stage %s will retry (%s)", lease.stage, type(exc).__name__)
            self._retry(lease, episode, reason, label)

    def _advance(self, lease: StageLease, **change: Any) -> None:
        if self.dispatch.advance(lease, self.now(), **change):
            self._publish(lease.episode_id)

    def _extract(self, lease: StageLease, episode: dict) -> None:
        previous = episode.get("previous")
        if previous and previous["state"] != "extracted" and previous["outcome"] == "pending":
            self._wait(lease, episode, "previous", self.settings.previous_wait_seconds, 5)
            return
        result = extract_episode(
            self.hub,
            episode,
            episode["messages"],
            (previous or {}).get("messages"),
            input_budget=self.settings.input_budget,
        )
        fields = {
            name: result[name]
            for name in ("drafts", "anchors", "anchor_keys", "episode_summary", "extract_status")
        }
        if result["drafts"]:
            self._advance(
                lease,
                **fields,
                state="extracted",
                stage="organizing_queued",
                extracted_at=self.now(),
                organize_result={},
            )
        else:
            self._advance(
                lease,
                **fields,
                state="extracted",
                stage="done",
                outcome="skipped",
                extracted_at=self.now(),
                result={"topic_ids": []},
                organize_result={},
            )

    def _organize(self, lease: StageLease, episode: dict) -> None:
        data = lease.data
        if data.get("conflicts", 0) >= 3 and not data.get("lock_token"):
            token = self._new_lock_token(lease)
            if not self.redis.set(self._space_key(episode), token, nx=True, ex=120):
                self._wait(lease, episode, "lock", self.settings.lock_wait_seconds, 1)
                return
            data["lock_token"] = token
        if data.get("lock_token") and not self._renew(episode, data["lock_token"]):
            self._restart(lease, episode)
            return
        space_id = episode["space_id"]
        topics = self.store.read_topics(space_id, episode["domains"])
        space = self.store.read_space(space_id)
        if space is None:
            self._terminal(lease, episode, "SPACE_CLEARED", "The Space was removed")
            return
        ranked, degraded = ranked_topics(self.store, episode, self.embedder)
        plan = organize_episode(
            self.hub,
            episode,
            recall_candidates(episode, topics, ranked, degraded=degraded),
            self.store.read_staged(space_id),
            space,
            now=self.now(),
            formation_count=self.settings.formation_count,
            formation_interval=self.settings.formation_interval,
            all_topics=topics,
            load_formation_topics=lambda domains: self.store.read_topics(space_id, domains),
        )
        if data.get("lock_token") and not self._renew(episode, data["lock_token"]):
            self._restart(lease, episode)
            return
        data = {**data, "plan": plan, "retries": 0}
        if plan["assignments"]:
            self._advance(lease, stage="awaiting_merge", organize_result=data)
        else:
            data["changeset"] = prepare_merge(self.hub, plan)
            self._advance(lease, stage="committing", organize_result=data)

    def _merge(self, lease: StageLease, episode: dict) -> None:
        token = lease.data.get("lock_token")
        if token and not self._renew(episode, token):
            self._restart(lease, episode)
            return
        prepared = prepare_merge(self.hub, lease.data["plan"])
        if token and not self._renew(episode, token):
            self._restart(lease, episode)
            return
        data = {**lease.data, "changeset": prepared, "retries": 0}
        self._advance(lease, stage="committing", organize_result=data)

    def _commit(self, lease: StageLease, episode: dict) -> None:
        data = lease.data
        token = data.get("lock_token")
        if token and not self._renew(episode, token):
            self._restart(lease, episode)
            return
        changeset = index_changeset(
            rewrite_metadata(self.hub, data["changeset"]),
            self.embedder,
            self.store.dim,
            model_id=self.embedding_model_id,
        )
        if token:
            if not self._renew(episode, token):
                self._restart(lease, episode)
                return
        else:
            token = self._new_lock_token(lease)
            if not self.redis.set(self._space_key(episode), token, nx=True, ex=30):
                self._wait(lease, episode, "lock", self.settings.lock_wait_seconds, 1)
                return
        try:
            commit_changeset(
                self.store, lease.episode_id, lease.attempt, changeset, work_token=lease.token
            )
        finally:
            self._release(episode, token)

    def _committed(self, lease: StageLease) -> bool:
        current = self.store.load_episode(lease.episode_id)
        return bool(current and current["commit_key"] == f"{lease.episode_id}:{lease.attempt}")

    def _conflict(self, lease: StageLease, episode: dict) -> None:
        changes = lease.data.get("changeset") or {}
        conflicts = lease.data.get("conflicts", 0) + 1
        if conflicts >= 6:
            self._terminal(lease, episode, "VERSION_CONFLICT", "Repeated concurrent Topic changes")
            return
        data = {"conflicts": conflicts}
        self._release(episode, lease.data.get("lock_token"))
        if conflicts < 3 and changes.get("kind") == "append":
            ids = [edit["topic"]["id"] for edit in changes["topics"]]
            topics = self.store.read_topics(episode["space_id"], topic_ids=ids)
            try:
                data["changeset"] = rebase_append_only(changes, topics)
            except VersionConflictError:
                pass
            else:
                self._advance(
                    lease, stage="committing", attempt=lease.attempt + 1, organize_result=data
                )
                return
        self._advance(lease, stage="organizing_queued", organize_result=data)

    def _restart(self, lease: StageLease, episode: dict) -> None:
        self._release(episode, lease.data.get("lock_token"))
        self._advance(
            lease,
            stage="organizing_queued",
            organize_result={"conflicts": lease.data.get("conflicts", 0)},
        )

    def _wait(
        self, lease: StageLease, episode: dict, kind: str, max_wait: int, base_delay: int
    ) -> None:
        data = dict(lease.data)
        now = self.now()
        began = datetime.fromisoformat(data.setdefault(f"{kind}_since", now.isoformat()))
        if (now - began).total_seconds() >= max_wait:
            self._terminal(lease, episode, "QUEUE_TIMEOUT", "Timed out waiting for " + kind)
            return
        tries = data.get(f"{kind}_retries", 0) + 1
        data[f"{kind}_retries"] = tries
        data["resume_stage"] = lease.stage
        self.dispatch.advance(
            lease,
            now,
            stage="retry_wait",
            next_retry_at=now + timedelta(seconds=min(10, base_delay * 2 ** min(tries - 1, 4))),
            organize_result=data,
        )

    def _retry(self, lease: StageLease, episode: dict, reason: str, label: str) -> None:
        retries = lease.data.get("retries", 0) + 1
        if retries > 3:
            self._terminal(lease, episode, reason, "Stage retry budget exhausted", exhausted=True)
            return
        data = {**lease.data, "retries": retries, "resume_stage": lease.stage}
        token = data.pop("lock_token", None)
        self._release(episode, token)
        if token and label != PROCESS:
            data = {
                "retries": retries,
                "conflicts": data.get("conflicts", 0),
                "resume_stage": "organizing_queued",
            }
        now = self.now()
        self.dispatch.advance(
            lease,
            now,
            stage="retry_wait",
            next_retry_at=now + timedelta(seconds=2**retries),
            last_error=episode.get("last_error") or self._error(lease, reason, "Stage will retry"),
            organize_result=data,
        )

    def _terminal(
        self,
        lease: StageLease,
        episode: dict,
        reason: str,
        message: str,
        *,
        exhausted: bool = False,
    ) -> None:
        self._release(episode, lease.data.get("lock_token"))
        error = self._error(lease, reason, message)
        if exhausted:
            error = dict(episode.get("last_error") or error)
            error["retry_exhausted"] = True
        self._advance(lease, outcome="failed", error=error, organize_result={})

    @staticmethod
    def _error(lease: StageLease, reason: str, message: str) -> dict[str, Any]:
        code = {
            "SPACE_CLEARED": 40902,
            "INVALID_EVIDENCE": 42201,
            "VERSION_CONFLICT": 40901,
            "QUEUE_TIMEOUT": 50401,
            "STORE_UNAVAILABLE": 50301,
            "MODEL_UNAVAILABLE": 50302,
        }[reason]
        return {
            "code": code,
            "reason": reason,
            "message": message,
            "origin": {"stage": lease.stage, "episode_id": lease.episode_id},
        }

    def _space_key(self, episode: dict) -> str:
        return f"project_space_lock:{episode['project_id']}:{episode['space_id']}"

    @staticmethod
    def _new_lock_token(lease: StageLease) -> str:
        return f"{lease.episode_id}:{lease.attempt}:{lease.token}"

    def _renew(self, episode: dict, token: str) -> bool:
        return bool(self.redis.eval(_RENEW_LOCK, 1, self._space_key(episode), token, 600))

    def _release(self, episode: dict, token: str | None) -> None:
        if token:
            try:
                self.redis.eval(_RELEASE_LOCK, 1, self._space_key(episode), token)
            except Exception as exc:
                logger.warning(
                    "Project Add will let the Space lock expire (%s)", type(exc).__name__
                )
