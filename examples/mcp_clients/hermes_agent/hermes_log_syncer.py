"""Sync completed Hermes turns from agent.log/state.db into MemOS as raw records."""

from __future__ import annotations

import argparse
import ast
import json
import os
import sqlite3
import time

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import requests


if TYPE_CHECKING:
    from collections.abc import Callable, Iterable


DEFAULT_LOG_PATH = Path.home() / ".hermes/logs/agent.log"
DEFAULT_STATE_DB_PATH = Path.home() / ".hermes/state.db"
DEFAULT_CURSOR_PATH = Path.home() / ".hermes/memos-log-syncer.cursor.json"
DEFAULT_CONFIG_PATH = Path.home() / ".hermes/memos-log-syncer.json"
DEFAULT_MCP_URL = "http://127.0.0.1:8766/mcp"
MCP_URL_ENV = "MEMOS_MCP_URL"
SYNCABLE_PLATFORMS = {"tui", "desktop"}
DEFAULT_SCHEDULER_BATCH_TURNS = 20
DEFAULT_SCHEDULER_BATCH_CHARS = 30000
DEFAULT_SCHEDULER_MAX_WAIT_SECONDS = 600.0


@dataclass(frozen=True)
class CompletedTurnEvent:
    session_id: str
    platform: str
    user_message: str
    response_len: int
    log_offset: int


@dataclass(frozen=True)
class CompletedTurn:
    session_id: str
    turn_id: str
    platform: str
    user_message: str
    assistant_response: str
    user_message_id: int
    assistant_message_id: int


def parse_completed_turn_events(
    lines: Iterable[str], start_offset: int = 0
) -> list[CompletedTurnEvent]:
    pending: dict[str, tuple[str, str]] = {}
    events: list[CompletedTurnEvent] = []
    offset = start_offset
    for line in lines:
        offset += len(line.encode("utf-8")) + 1
        if "agent.turn_context: conversation turn:" in line:
            parsed = _parse_turn_start(line)
            if parsed is not None:
                session_id, platform, user_message = parsed
                pending[session_id] = (platform, user_message)
            continue
        if "agent.conversation_loop: Turn ended:" not in line:
            continue
        parsed_end = _parse_turn_end(line)
        if parsed_end is None:
            continue
        session_id, reason, last_role, response_len = parsed_end
        pending_start = pending.pop(session_id, None)
        if pending_start is None:
            continue
        platform, user_message = pending_start
        if (
            platform in SYNCABLE_PLATFORMS
            and reason.startswith("text_response")
            and last_role == "assistant"
            and response_len > 0
        ):
            events.append(
                CompletedTurnEvent(
                    session_id=session_id,
                    platform=platform,
                    user_message=user_message,
                    response_len=response_len,
                    log_offset=offset,
                )
            )
    return events


def collect_completed_turns(
    state_db_path: Path,
    events: Iterable[CompletedTurnEvent],
) -> list[CompletedTurn]:
    turns: list[CompletedTurn] = []
    with sqlite3.connect(state_db_path) as conn:
        conn.row_factory = sqlite3.Row
        for event in events:
            messages = conn.execute(
                """
                SELECT id, role, content
                FROM messages
                WHERE session_id = ? AND active = 1 AND role IN ('user', 'assistant')
                ORDER BY timestamp, id
                """,
                (event.session_id,),
            ).fetchall()
            turn = _pair_event_with_messages(event, messages)
            if turn is not None:
                turns.append(turn)
    return turns


def build_raw_turn_tool_arguments(
    *,
    session_id: str,
    turn_id: str,
    user_message: str,
    assistant_response: str,
    platform: str,
    max_chars: int,
) -> dict[str, str]:
    user_text = _truncate(user_message.strip(), max_chars)
    assistant_text = _truncate(assistant_response.strip(), max_chars)
    payload = {
        "turn_id": turn_id,
        "messages": [
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": assistant_text},
        ],
        "metadata": {
            "memory_type": "RawConversationTurn",
            "status": "archived",
            "source": "conversation",
            "source_agent": "hermes_desktop",
            "platform": platform,
            "ingested_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    return {
        "raw_turn_json": json.dumps(payload, ensure_ascii=False),
        "session_id": session_id,
    }


class HermesLogSyncer:
    def __init__(
        self,
        *,
        log_path: Path = DEFAULT_LOG_PATH,
        state_db_path: Path = DEFAULT_STATE_DB_PATH,
        cursor_path: Path = DEFAULT_CURSOR_PATH,
        max_chars: int = 4000,
        scheduler_batch_turns: int = DEFAULT_SCHEDULER_BATCH_TURNS,
        scheduler_batch_chars: int = DEFAULT_SCHEDULER_BATCH_CHARS,
        scheduler_max_wait_seconds: float = DEFAULT_SCHEDULER_MAX_WAIT_SECONDS,
        writer: MemosMCPWriter | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self.log_path = log_path
        self.state_db_path = state_db_path
        self.cursor_path = cursor_path
        self.max_chars = max_chars
        self.scheduler_batch_turns = scheduler_batch_turns
        self.scheduler_batch_chars = scheduler_batch_chars
        self.scheduler_max_wait_seconds = scheduler_max_wait_seconds
        self.writer = writer or MemosMCPWriter()
        self._now = now or time.time

    def run_once(self, dry_run: bool = False, flush_scheduler: bool = False) -> int:
        cursor = self._load_cursor()
        offset = int(cursor.get("log_offset", 0))
        synced_turns = set(cursor.get("synced_turns", []))
        pending_raw_memory_ids = list(cursor.get("pending_raw_memory_ids", []))
        pending_session_id = str(cursor.get("pending_session_id", ""))
        pending_raw_memory_chars = int(cursor.get("pending_raw_memory_chars", 0))
        pending_first_seen_at = cursor.get("pending_first_seen_at")
        text, new_offset = self._read_new_log_text(offset)
        events, complete_log_offset = parse_completed_turn_events_with_safe_offset(
            text, start_offset=offset, end_offset=new_offset
        )
        synced_count = 0
        safe_offset = complete_log_offset
        for event in events:
            turns = collect_completed_turns(self.state_db_path, [event])
            if not turns:
                safe_offset = offset
                break
            turn = turns[0]
            if turn.turn_id in synced_turns:
                continue
            arguments = build_raw_turn_tool_arguments(
                session_id=turn.session_id,
                turn_id=turn.turn_id,
                user_message=turn.user_message,
                assistant_response=turn.assistant_response,
                platform=turn.platform,
                max_chars=self.max_chars,
            )
            if not dry_run:
                result = self.writer.write_raw_turn(arguments)
                if result is None or result.startswith("Error "):
                    raise RuntimeError(result or "empty response from add_raw_conversation_turn")
                raw_memory_id = _extract_success_memory_id(result)
                if pending_first_seen_at is None:
                    pending_first_seen_at = self._now()
                pending_raw_memory_ids.append(raw_memory_id)
                pending_session_id = turn.session_id
                pending_raw_memory_chars += len(turn.user_message) + len(turn.assistant_response)
                synced_turns.add(turn.turn_id)
            synced_count += 1
        pending_age_seconds = (
            self._now() - float(pending_first_seen_at) if pending_first_seen_at is not None else 0
        )
        if (
            not dry_run
            and pending_raw_memory_ids
            and (
                flush_scheduler
                or len(pending_raw_memory_ids) >= self.scheduler_batch_turns
                or pending_raw_memory_chars >= self.scheduler_batch_chars
                or pending_age_seconds >= self.scheduler_max_wait_seconds
            )
        ):
            result = self.writer.process_raw_turns(pending_raw_memory_ids, pending_session_id)
            if result is None or result.startswith("Error "):
                raise RuntimeError(result or "empty response from process_raw_conversation_turns")
            pending_raw_memory_ids = []
            pending_session_id = ""
            pending_raw_memory_chars = 0
            pending_first_seen_at = None
        if not dry_run:
            self._save_cursor(
                {
                    "log_offset": safe_offset,
                    "synced_turns": sorted(synced_turns),
                    "pending_raw_memory_ids": pending_raw_memory_ids,
                    "pending_session_id": pending_session_id,
                    "pending_raw_memory_chars": pending_raw_memory_chars,
                    "pending_first_seen_at": pending_first_seen_at,
                }
            )
        return synced_count

    def follow(self, interval_seconds: float = 2.0, dry_run: bool = False) -> None:
        while True:
            self.run_once(dry_run=dry_run)
            time.sleep(interval_seconds)

    def _read_new_log_text(self, offset: int) -> tuple[str, int]:
        current_size = self.log_path.stat().st_size
        if offset > current_size:
            offset = 0
        with self.log_path.open("rb") as file:
            file.seek(offset)
            data = file.read()
            new_offset = file.tell()
        return data.decode("utf-8", errors="replace"), new_offset

    def _load_cursor(self) -> dict:
        if not self.cursor_path.exists():
            return {"log_offset": 0, "synced_turns": []}
        return json.loads(self.cursor_path.read_text())

    def _save_cursor(self, cursor: dict) -> None:
        self.cursor_path.parent.mkdir(parents=True, exist_ok=True)
        self.cursor_path.write_text(json.dumps(cursor, ensure_ascii=False, indent=2))


class MemosMCPWriter:
    def __init__(self, url: str = DEFAULT_MCP_URL, timeout: float = 10.0) -> None:
        self.url = url
        self.timeout = timeout
        self._session = requests.Session()
        self._session.trust_env = False
        self._session_id = ""
        self._request_id = 0

    def write_raw_turn(self, arguments: dict[str, str]) -> str | None:
        return self._call_tool("add_raw_conversation_turn", arguments)

    def process_raw_turns(self, memory_ids: list[str], session_id: str) -> str | None:
        return self._call_tool(
            "process_raw_conversation_turns",
            {
                "raw_memory_ids_json": json.dumps(memory_ids, ensure_ascii=False),
                "session_id": session_id,
            },
        )

    def _call_tool(self, name: str, arguments: dict[str, str]) -> str | None:
        if not self._session_id:
            self._initialize()
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        response = self._session.post(
            self.url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Mcp-Session-Id": self._session_id,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        data = _parse_sse(response.content.decode("utf-8"))
        content = data.get("result", {}).get("content") or []
        return content[0].get("text") if content else None

    def _initialize(self) -> None:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "hermes-log-syncer", "version": "1.0.0"},
            },
        }
        response = self._session.post(
            self.url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        self._session_id = response.headers["Mcp-Session-Id"]

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id


def _parse_turn_start(line: str) -> tuple[str, str, str] | None:
    session_id = _extract_token(line, "session")
    platform = _extract_token(line, "platform")
    marker = " msg="
    if not session_id or not platform or marker not in line:
        return None
    raw_message = line.split(marker, 1)[1]
    try:
        user_message = ast.literal_eval(raw_message)
    except (SyntaxError, ValueError):
        user_message = raw_message.strip("'\"")
    if not isinstance(user_message, str):
        user_message = str(user_message)
    return session_id, platform, user_message


def parse_completed_turn_events_with_safe_offset(
    text: str, start_offset: int = 0, end_offset: int | None = None
) -> tuple[list[CompletedTurnEvent], int]:
    pending: dict[str, tuple[str, str, int]] = {}
    events: list[CompletedTurnEvent] = []
    offset = start_offset
    for line in text.splitlines(keepends=True):
        line_start_offset = offset
        offset += len(line.encode("utf-8"))
        stripped_line = line.rstrip("\r\n")
        if "agent.turn_context: conversation turn:" in stripped_line:
            parsed = _parse_turn_start(stripped_line)
            if parsed is not None:
                session_id, platform, user_message = parsed
                pending[session_id] = (platform, user_message, line_start_offset)
            continue
        if "agent.conversation_loop: Turn ended:" not in stripped_line:
            continue
        parsed_end = _parse_turn_end(stripped_line)
        if parsed_end is None:
            continue
        session_id, reason, last_role, response_len = parsed_end
        pending_start = pending.pop(session_id, None)
        if pending_start is None:
            continue
        platform, user_message, _ = pending_start
        if (
            platform in SYNCABLE_PLATFORMS
            and reason.startswith("text_response")
            and last_role == "assistant"
            and response_len > 0
        ):
            events.append(
                CompletedTurnEvent(
                    session_id=session_id,
                    platform=platform,
                    user_message=user_message,
                    response_len=response_len,
                    log_offset=offset,
                )
            )
    safe_offset = end_offset if end_offset is not None else offset
    if pending:
        safe_offset = min(pending_start_offset for _, _, pending_start_offset in pending.values())
    return events, safe_offset


def _parse_sse(text: str) -> dict:
    for block in text.replace("\r\n", "\n").split("\n\n"):
        data_parts = []
        for line in block.splitlines():
            if line.startswith("data:"):
                data_parts.append(line[5:].lstrip())
            elif data_parts:
                data_parts.append(line)
        if data_parts:
            try:
                return json.loads("".join(data_parts))
            except json.JSONDecodeError:
                continue
    return {}


def _parse_turn_end(line: str) -> tuple[str, str, str, int] | None:
    session_id = _extract_token(line, "session")
    reason = _extract_token(line, "reason")
    last_role = _extract_token(line, "last_msg_role")
    response_len_raw = _extract_token(line, "response_len")
    if not session_id or not reason or not last_role or response_len_raw is None:
        return None
    try:
        response_len = int(response_len_raw)
    except ValueError:
        return None
    return session_id, reason, last_role, response_len


def _extract_token(line: str, name: str) -> str | None:
    needle = f"{name}="
    if needle not in line:
        return None
    value = line.split(needle, 1)[1]
    return value.split(maxsplit=1)[0]


def _pair_event_with_messages(
    event: CompletedTurnEvent,
    messages: Iterable[sqlite3.Row],
) -> CompletedTurn | None:
    rows = list(messages)
    for index, row in enumerate(rows):
        if row["role"] != "user" or (row["content"] or "") != event.user_message:
            continue
        for assistant in rows[index + 1 :]:
            if assistant["role"] == "assistant" and (assistant["content"] or "").strip():
                return CompletedTurn(
                    session_id=event.session_id,
                    turn_id=f"{event.session_id}:{row['id']}:{assistant['id']}",
                    platform=event.platform,
                    user_message=row["content"] or "",
                    assistant_response=assistant["content"] or "",
                    user_message_id=int(row["id"]),
                    assistant_message_id=int(assistant["id"]),
                )
    return None


def _truncate(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n[truncated]"


def _extract_success_memory_id(result: str) -> str:
    prefix = "Raw conversation turn added successfully: "
    if not result.startswith(prefix):
        raise RuntimeError(f"unexpected add_raw_conversation_turn response: {result}")
    memory_id = result.removeprefix(prefix).strip()
    if not memory_id:
        raise RuntimeError("add_raw_conversation_turn response did not include memory id")
    return memory_id


def resolve_mcp_url(cli_url: str | None, config_path: Path = DEFAULT_CONFIG_PATH) -> str:
    if cli_url:
        return cli_url
    env_url = os.getenv(MCP_URL_ENV)
    if env_url:
        return env_url
    config = _load_syncer_config(config_path)
    configured_url = config.get("mcp_url")
    if isinstance(configured_url, str) and configured_url:
        return configured_url
    return DEFAULT_MCP_URL


def write_syncer_config(config_path: Path, mcp_url: str) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"mcp_url": mcp_url}, ensure_ascii=False, indent=2) + "\n")


def _load_syncer_config(config_path: Path) -> dict:
    if not config_path.exists():
        return {}
    return json.loads(config_path.read_text())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-path", type=Path, default=DEFAULT_LOG_PATH)
    parser.add_argument("--state-db-path", type=Path, default=DEFAULT_STATE_DB_PATH)
    parser.add_argument("--cursor-path", type=Path, default=DEFAULT_CURSOR_PATH)
    parser.add_argument("--config-path", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--mcp-url", default=None)
    parser.add_argument("--init-config", action="store_true")
    parser.add_argument("--max-chars", type=int, default=4000)
    parser.add_argument("--scheduler-batch-turns", type=int, default=DEFAULT_SCHEDULER_BATCH_TURNS)
    parser.add_argument("--scheduler-batch-chars", type=int, default=DEFAULT_SCHEDULER_BATCH_CHARS)
    parser.add_argument(
        "--scheduler-max-wait-seconds",
        type=float,
        default=DEFAULT_SCHEDULER_MAX_WAIT_SECONDS,
    )
    parser.add_argument("--flush-scheduler", action="store_true")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    mcp_url = resolve_mcp_url(args.mcp_url, args.config_path)
    if args.init_config:
        write_syncer_config(args.config_path, mcp_url)
        print(f"config_path={args.config_path}")
        print(f"mcp_url={mcp_url}")
        return

    syncer = HermesLogSyncer(
        log_path=args.log_path,
        state_db_path=args.state_db_path,
        cursor_path=args.cursor_path,
        max_chars=args.max_chars,
        scheduler_batch_turns=args.scheduler_batch_turns,
        scheduler_batch_chars=args.scheduler_batch_chars,
        scheduler_max_wait_seconds=args.scheduler_max_wait_seconds,
        writer=MemosMCPWriter(url=mcp_url),
    )
    if args.once:
        synced = syncer.run_once(dry_run=args.dry_run, flush_scheduler=args.flush_scheduler)
        print(f"synced_turns={synced}")
    else:
        syncer.follow(interval_seconds=args.interval, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
