"""Stable request folders and rebuildable per-user trace indexes."""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import threading

from collections import OrderedDict
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote
from uuid import uuid4
from zoneinfo import ZoneInfo

from memos.exceptions import MemOSError
from memos.log import get_logger


if TYPE_CHECKING:
    from collections.abc import Sequence

    from memos_smartcomment.config import SmartCommentSettings
    from memos_smartcomment.events import TraceEvent


logger = get_logger(__name__)


def _digest(value: str | None) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode("utf-8")).hexdigest()


def _prefix(value: str | None, fallback: str) -> str:
    # Keep Unicode letters, but never separators, control characters or dot segments.
    return (re.sub(r"[^\w.-]+", "_", value or fallback).strip("._") or fallback)[:32]


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def _timestamp(value: str) -> datetime:
    timestamp = datetime.fromisoformat(value)
    return timestamp if timestamp.tzinfo is not None else timestamp.replace(tzinfo=UTC)


def _atomic_write(path: Path, value: dict[str, Any] | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(
            value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _reserve(path: Path, value: dict[str, Any]) -> None:
    """Reserve a new identity without consuming a directory name on write failure."""
    try:
        _atomic_write(path, value)
    except Exception:
        # Remove only an empty reservation directory; never discard existing files.
        with suppress(OSError):
            path.parent.rmdir()
        raise


def _entry_type(event: TraceEvent) -> str:
    if event.operation.startswith("memos.search."):
        return "search"
    if event.operation.startswith(("memos.add.", "memos.mem_reader.", "memos.text_memory.")):
        return "add"
    if event.operation.startswith("memos.scheduler."):
        return "memread"
    return "other"


def _summary(event: TraceEvent) -> str:
    values = [*event.inputs, *event.outputs]
    values.extend(value for link in event.links for value in (link.source, link.target))
    for value in values:
        if value.identity_only:
            continue
        text = ""
        if value.category == "search_query" and isinstance(value.value, str):
            text = value.value
        elif value.category == "input_message_batch" and isinstance(value.value, list):
            messages = value.value
            snippets = []
            for message in messages:
                content = message.get("content", "") if isinstance(message, dict) else message
                if isinstance(content, str) and content.strip():
                    snippets.append(content)
                    break
            text = f"{len(messages)} messages" + (f": {snippets[0]}" if snippets else "")
        if text:
            text = " ".join(text.split())
            return text[:160] + ("…" if len(text) > 160 else "")
    return ""


def _markdown(value: Any) -> str:
    text = html.escape(" ".join(str(value or "").split()), quote=False)
    return re.sub(r"([\\`*_{}\[\]()|!])", r"\\\1", text)


class TraceStore:
    """One writer per output directory; metadata fixes each trace's location forever."""

    def __init__(self, settings: SmartCommentSettings) -> None:
        self.root = settings.output_dir
        # None lets astimezone use local rules at the event's date, including DST.
        self.timezone = (
            None if settings.output_timezone == "local" else ZoneInfo(settings.output_timezone)
        )
        self.project_id = settings.project_id
        self._lock = threading.RLock()
        self._catalogs: OrderedDict[Path, dict[str, dict[str, Any]]] = OrderedDict()
        self._dirty_users: dict[Path, str | None] = {}

    def _user_directory(self, user_id: str | None, *, create: bool = False) -> Path | None:
        digest = _digest(user_id)
        available = None
        for length in (12, 20, 32, 64):
            path = self.root / f"{_prefix(user_id, 'anonymous')}--{digest[:length]}"
            if path.exists():
                try:
                    owner = _read(path / "_user.json")
                    if "user_id" in owner and owner["user_id"] == user_id:
                        return path
                except (OSError, ValueError):
                    pass
                continue
            if available is None:
                available = path
            # An earlier colliding user may have been deleted; check longer candidates too.
        if create:
            if available is not None:
                _reserve(available / "_user.json", {"user_id": user_id})
                return available
            raise MemOSError("Cannot allocate a distinct memtrace user directory")
        return None

    @staticmethod
    def _path(user: Path, relative: str) -> Path:
        path = user / relative
        parts = Path(relative).parts
        if (
            len(parts) != 4
            or parts[-1] != "graph.json"
            or not path.resolve().is_relative_to(user.resolve())
            or ".." in parts
        ):
            raise ValueError("Invalid trace graph path")
        return path

    def _catalog(self, user: Path, user_id: str | None) -> dict[str, dict[str, Any]]:
        if user in self._catalogs:
            self._catalogs.move_to_end(user)
            return self._catalogs[user]
        entries: dict[str, dict[str, Any]] = {}
        # Rebuild the in-memory index from metadata once after startup/cache eviction.
        # This also recovers a crash between graph replacement and index publication.
        for meta_path in sorted(user.glob("*/*/*/meta.json")):
            try:
                meta = _read(meta_path)
                path = self._path(user, meta["path"])
                if (
                    meta.get("schema_version") != 1
                    or meta["user_id"] != user_id
                    or path.parent != meta_path.parent
                    or not isinstance(meta["trace_id"], str)
                ):
                    raise ValueError("Trace metadata does not match its location")
                if meta["trace_id"] in entries:
                    raise MemOSError("Multiple folders claim the same memtrace trace ID")
                entries[meta["trace_id"]] = meta
            except (OSError, ValueError, KeyError, TypeError):
                logger.warning("Unable to read memtrace metadata: %s", meta_path)
        self._catalogs[user] = entries
        if len(self._catalogs) > 8:
            self._catalogs.popitem(last=False)
        return entries

    def output_path(self, trace_id: str, user_id: str | None) -> Path:
        """Find an allocated graph; unknown traces raise FileNotFoundError without writes."""
        with self._lock:
            user = self._user_directory(user_id)
            entry = self._catalog(user, user_id).get(trace_id) if user is not None else None
            if entry is None:
                raise FileNotFoundError(f"No recorded memtrace graph for trace {trace_id!r}")
            return self._path(user, entry["path"])

    def graph_paths(self, user_id: str | None) -> tuple[Path, ...]:
        """Enumerate only this user's graphs, across all dates and entry types."""
        with self._lock:
            user = self._user_directory(user_id)
            if user is None:
                return ()
            return tuple(
                self._path(user, entry["path"])
                for entry in self._catalog(user, user_id).values()
                if self._path(user, entry["path"]).is_file()
            )

    def _allocate(self, user: Path, event: TraceEvent) -> dict[str, Any]:
        local = _timestamp(event.created_at).astimezone(self.timezone)
        entry_type = _entry_type(event)
        parent = user / local.strftime("%Y-%m-%d") / entry_type
        prefix = f"{local.strftime('%H-%M-%S')}.{local.microsecond // 1000:03d}"
        digest = _digest(event.trace_id)
        for length in (12, 20, 32, 64):
            path = parent / f"{prefix}__{_prefix(event.trace_id, 'trace')}--{digest[:length]}"
            if not path.exists():
                break
        else:
            raise MemOSError("Cannot allocate a distinct memtrace request directory")
        entry = {
            "schema_version": 1,
            "trace_id": event.trace_id,
            "user_id": event.user_id,
            "project_id": self.project_id,
            "entry_type": entry_type,
            "first_seen_at": event.created_at,
            "last_seen_at": event.created_at,
            "display_time": local.isoformat(timespec="milliseconds"),
            "timezone": str(self.timezone or local.tzinfo),
            "summary": _summary(event),
            "session_id": event.session_id,
            "task_id": event.task_id,
            "cube_ids": list(event.cube_ids),
            "operations": [event.operation],
            "path": (path / "graph.json").relative_to(user).as_posix(),
        }
        # Reserve the identity before writing the graph so a failed write retries in place.
        _reserve(path / "meta.json", entry)
        return entry

    def write(self, events: Sequence[TraceEvent], graph: dict[str, Any]) -> None:
        """Commit one trace snapshot and all of its pending metadata; defer indexes."""
        event = events[0]
        with self._lock:
            user = self._user_directory(event.user_id, create=True)
            entries = self._catalog(user, event.user_id)
            if event.trace_id not in entries:
                entries[event.trace_id] = self._allocate(user, event)
            entry = dict(entries[event.trace_id])
            if entry["project_id"] != self.project_id:
                raise MemOSError("Trace directory belongs to a different project")
            path = self._path(user, entry["path"])
            for observation in events:
                entry["last_seen_at"] = max(
                    (entry["last_seen_at"], observation.created_at), key=_timestamp
                )
                entry["summary"] = entry["summary"] or _summary(observation)
                entry["session_id"] = entry["session_id"] or observation.session_id
                entry["task_id"] = entry["task_id"] or observation.task_id
                entry["cube_ids"] = sorted(set(entry["cube_ids"]) | set(observation.cube_ids))
                entry["operations"] = sorted(set(entry["operations"]) | {observation.operation})
            _atomic_write(path, graph)
            _atomic_write(path.with_name("meta.json"), entry)
            entries[event.trace_id] = entry
            self._dirty_users[user] = event.user_id

    @property
    def pending_indexes(self) -> bool:
        """Whether committed graphs still need index publication."""
        with self._lock:
            return bool(self._dirty_users)

    def publish_indexes(self) -> int:
        """Refresh each dirty user's indexes once; retain failures for retry."""
        failed = 0
        with self._lock:
            for user, user_id in tuple(self._dirty_users.items()):
                try:
                    self._publish(user, user_id, self._catalog(user, user_id))
                except Exception:
                    failed += 1
                    logger.exception("Failed to publish memtrace indexes: %s", user)
                else:
                    del self._dirty_users[user]
        return failed

    def _publish(self, user: Path, user_id: str | None, entries: dict[str, dict[str, Any]]) -> None:
        committed = {
            key: value
            for key, value in entries.items()
            if self._path(user, value["path"]).is_file()
        }
        _atomic_write(
            user / "_index.json",
            {
                "schema_version": 1,
                "user_id": user_id,
                "traces": committed,
            },
        )
        rows = [
            "# Memtrace requests",
            "",
            "Times include their UTC offset. Graphs may receive asynchronous updates.",
            "",
            "| Time | Type | Request summary | Trace ID | Graph |",
            "| --- | --- | --- | --- | --- |",
        ]
        for entry in sorted(
            committed.values(), key=lambda item: _timestamp(item["first_seen_at"]), reverse=True
        ):
            cells = [
                _markdown(entry[key])
                for key in (
                    "display_time",
                    "entry_type",
                    "summary",
                    "trace_id",
                )
            ]
            rows.append("| " + " | ".join(cells) + f" | [graph]({quote(entry['path'])}) |")
        _atomic_write(user / "index.md", "\n".join(rows) + "\n")
