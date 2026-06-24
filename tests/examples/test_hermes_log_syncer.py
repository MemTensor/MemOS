import json
import sqlite3

from pathlib import Path

from examples.mcp_clients.hermes_agent.hermes_log_syncer import (
    DEFAULT_MCP_URL,
    HermesLogSyncer,
    MemosMCPWriter,
    build_raw_turn_tool_arguments,
    collect_completed_turns,
    parse_completed_turn_events,
    parse_completed_turn_events_with_safe_offset,
    resolve_mcp_url,
    write_syncer_config,
)


def test_parse_completed_turn_events_pairs_user_line_with_successful_turn_end():
    log_text = "\n".join(
        [
            "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: conversation turn: session=s1 model=qwen provider=custom platform=tui history=0 msg='你好'",
            "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: Turn ended: reason=text_response(finish_reason=stop) model=qwen api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant response_len=12 session=s1",
            "2026-06-24 10:00:04,000 INFO [s2] agent.turn_context: conversation turn: session=s2 model=qwen provider=custom platform=subagent history=0 msg='后台任务'",
            "2026-06-24 10:00:05,000 INFO [s2] agent.conversation_loop: Turn ended: reason=interrupted_by_user model=qwen api_calls=0/60 budget=0/60 tool_turns=0 last_msg_role=user response_len=0 session=s2",
        ]
    )

    events = parse_completed_turn_events(log_text.splitlines())

    assert len(events) == 1
    assert events[0].session_id == "s1"
    assert events[0].platform == "tui"
    assert events[0].user_message == "你好"
    assert events[0].response_len == 12


def test_parse_completed_turn_events_keeps_offset_before_unclosed_turn_start():
    log_text = "\n".join(
        [
            "2026-06-24 10:00:00,000 INFO [s1] unrelated line",
            "2026-06-24 10:00:01,000 INFO [s1] agent.turn_context: "
            "conversation turn: session=s1 model=qwen provider=custom "
            "platform=tui history=0 msg='未完成'",
        ]
    )
    turn_start_offset = log_text.index("2026-06-24 10:00:01")

    events, safe_offset = parse_completed_turn_events_with_safe_offset(
        log_text, start_offset=0, end_offset=len(log_text.encode("utf-8"))
    )

    assert events == []
    assert safe_offset == turn_start_offset


def test_collect_completed_turns_reads_full_user_and_assistant_from_state_db(tmp_path):
    db_path = tmp_path / "state.db"
    _create_state_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("s1", "tui", 1.0),
        )
        conn.executemany(
            "INSERT INTO messages(id, session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, ?, 1)",
            [
                (1, "s1", "user", "你好", 10.0),
                (2, "s1", "assistant", "你好，我可以帮你。", 11.0),
            ],
        )

    events = parse_completed_turn_events(
        [
            "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: conversation turn: session=s1 model=qwen provider=custom platform=tui history=0 msg='你好'",
            "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: Turn ended: reason=text_response(finish_reason=stop) model=qwen api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant response_len=12 session=s1",
        ]
    )

    turns = collect_completed_turns(db_path, events)

    assert len(turns) == 1
    assert turns[0].session_id == "s1"
    assert turns[0].user_message == "你好"
    assert turns[0].assistant_response == "你好，我可以帮你。"
    assert turns[0].turn_id == "s1:1:2"


def test_build_raw_turn_tool_arguments_marks_turn_archived_and_source_agent():
    arguments = build_raw_turn_tool_arguments(
        session_id="s1",
        turn_id="s1:1:2",
        user_message="你好",
        assistant_response="你好，我可以帮你。",
        platform="tui",
        max_chars=1000,
    )

    payload = json.loads(arguments["raw_turn_json"])

    assert arguments["session_id"] == "s1"
    assert payload["metadata"]["memory_type"] == "RawConversationTurn"
    assert payload["metadata"]["status"] == "archived"
    assert payload["metadata"]["source_agent"] == "hermes_desktop"
    assert payload["metadata"]["platform"] == "tui"
    assert payload["messages"] == [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "你好，我可以帮你。"},
    ]


def test_dry_run_does_not_advance_cursor_or_write_memory(tmp_path):
    log_path = tmp_path / "agent.log"
    db_path = tmp_path / "state.db"
    cursor_path = tmp_path / "cursor.json"
    writer = _FakeWriter()
    _create_state_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("s1", "tui", 1.0),
        )
        conn.executemany(
            "INSERT INTO messages(id, session_id, role, content, timestamp, active) "
            "VALUES (?, ?, ?, ?, ?, 1)",
            [
                (1, "s1", "user", "你好", 10.0),
                (2, "s1", "assistant", "你好，我可以帮你。", 11.0),
            ],
        )
    log_path.write_text(
        "\n".join(
            [
                "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: "
                "conversation turn: session=s1 model=qwen provider=custom "
                "platform=tui history=0 msg='你好'",
                "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: "
                "Turn ended: reason=text_response(finish_reason=stop) model=qwen "
                "api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant "
                "response_len=12 session=s1",
            ]
        )
    )

    syncer = HermesLogSyncer(
        log_path=log_path,
        state_db_path=db_path,
        cursor_path=cursor_path,
        writer=writer,
    )

    assert syncer.run_once(dry_run=True) == 1
    assert writer.calls == []
    assert not cursor_path.exists()


def test_scheduler_batch_flushes_when_threshold_reached(tmp_path):
    log_path = tmp_path / "agent.log"
    db_path = tmp_path / "state.db"
    cursor_path = tmp_path / "cursor.json"
    writer = _FakeWriter(result="Raw conversation turn added successfully: raw-1")
    _create_state_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("s1", "tui", 1.0),
        )
        conn.executemany(
            "INSERT INTO messages(id, session_id, role, content, timestamp, active) "
            "VALUES (?, ?, ?, ?, ?, 1)",
            [
                (1, "s1", "user", "你好", 10.0),
                (2, "s1", "assistant", "你好", 11.0),
            ],
        )
    log_path.write_text(
        "\n".join(
            [
                "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: "
                "conversation turn: session=s1 model=qwen provider=custom "
                "platform=tui history=0 msg='你好'",
                "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: "
                "Turn ended: reason=text_response(finish_reason=stop) model=qwen "
                "api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant "
                "response_len=12 session=s1",
            ]
        )
    )

    syncer = HermesLogSyncer(
        log_path=log_path,
        state_db_path=db_path,
        cursor_path=cursor_path,
        scheduler_batch_turns=1,
        writer=writer,
    )

    assert syncer.run_once() == 1
    assert writer.processed_batches == [(["raw-1"], "s1")]
    saved = json.loads(cursor_path.read_text())
    assert saved["pending_raw_memory_ids"] == []


def test_scheduler_batch_waits_until_threshold(tmp_path):
    log_path = tmp_path / "agent.log"
    db_path = tmp_path / "state.db"
    cursor_path = tmp_path / "cursor.json"
    writer = _FakeWriter(result="Raw conversation turn added successfully: raw-1")
    _create_state_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("s1", "tui", 1.0),
        )
        conn.executemany(
            "INSERT INTO messages(id, session_id, role, content, timestamp, active) "
            "VALUES (?, ?, ?, ?, ?, 1)",
            [
                (1, "s1", "user", "你好", 10.0),
                (2, "s1", "assistant", "你好", 11.0),
            ],
        )
    log_path.write_text(
        "\n".join(
            [
                "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: "
                "conversation turn: session=s1 model=qwen provider=custom "
                "platform=tui history=0 msg='你好'",
                "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: "
                "Turn ended: reason=text_response(finish_reason=stop) model=qwen "
                "api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant "
                "response_len=12 session=s1",
            ]
        )
    )

    syncer = HermesLogSyncer(
        log_path=log_path,
        state_db_path=db_path,
        cursor_path=cursor_path,
        scheduler_batch_turns=50,
        writer=writer,
    )

    assert syncer.run_once() == 1
    assert writer.processed_batches == []
    saved = json.loads(cursor_path.read_text())
    assert saved["pending_raw_memory_ids"] == ["raw-1"]


def test_scheduler_batch_flushes_when_pending_chars_reach_limit(tmp_path):
    log_path = tmp_path / "agent.log"
    db_path = tmp_path / "state.db"
    cursor_path = tmp_path / "cursor.json"
    writer = _FakeWriter(result="Raw conversation turn added successfully: raw-1")
    _create_state_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("s1", "tui", 1.0),
        )
        conn.executemany(
            "INSERT INTO messages(id, session_id, role, content, timestamp, active) "
            "VALUES (?, ?, ?, ?, ?, 1)",
            [
                (1, "s1", "user", "你好", 10.0),
                (2, "s1", "assistant", "这个回答比较长", 11.0),
            ],
        )
    log_path.write_text(
        "\n".join(
            [
                "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: "
                "conversation turn: session=s1 model=qwen provider=custom "
                "platform=tui history=0 msg='你好'",
                "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: "
                "Turn ended: reason=text_response(finish_reason=stop) model=qwen "
                "api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant "
                "response_len=12 session=s1",
            ]
        )
    )

    syncer = HermesLogSyncer(
        log_path=log_path,
        state_db_path=db_path,
        cursor_path=cursor_path,
        scheduler_batch_turns=50,
        scheduler_batch_chars=1,
        writer=writer,
    )

    assert syncer.run_once() == 1
    assert writer.processed_batches == [(["raw-1"], "s1")]
    saved = json.loads(cursor_path.read_text())
    assert saved["pending_raw_memory_ids"] == []
    assert saved["pending_raw_memory_chars"] == 0


def test_scheduler_batch_flushes_when_pending_age_reaches_limit(tmp_path):
    log_path = tmp_path / "agent.log"
    db_path = tmp_path / "state.db"
    cursor_path = tmp_path / "cursor.json"
    writer = _FakeWriter()
    _create_state_db(db_path)
    cursor_path.write_text(
        json.dumps(
            {
                "log_offset": 0,
                "synced_turns": [],
                "pending_raw_memory_ids": ["raw-1"],
                "pending_session_id": "s1",
                "pending_raw_memory_chars": 12,
                "pending_first_seen_at": 1000.0,
            }
        )
    )
    log_path.write_text("")

    syncer = HermesLogSyncer(
        log_path=log_path,
        state_db_path=db_path,
        cursor_path=cursor_path,
        scheduler_batch_turns=50,
        scheduler_batch_chars=30000,
        scheduler_max_wait_seconds=600,
        writer=writer,
        now=lambda: 1600.0,
    )

    assert syncer.run_once() == 0
    assert writer.processed_batches == [(["raw-1"], "s1")]
    saved = json.loads(cursor_path.read_text())
    assert saved["pending_raw_memory_ids"] == []
    assert saved["pending_first_seen_at"] is None


def test_unmatched_event_does_not_advance_cursor(tmp_path):
    log_path = tmp_path / "agent.log"
    db_path = tmp_path / "state.db"
    cursor_path = tmp_path / "cursor.json"
    _create_state_db(db_path)
    log_path.write_text(
        "\n".join(
            [
                "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: "
                "conversation turn: session=s1 model=qwen provider=custom "
                "platform=tui history=0 msg='还没写进 sqlite'",
                "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: "
                "Turn ended: reason=text_response(finish_reason=stop) model=qwen "
                "api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant "
                "response_len=12 session=s1",
            ]
        )
    )

    syncer = HermesLogSyncer(
        log_path=log_path,
        state_db_path=db_path,
        cursor_path=cursor_path,
        writer=_FakeWriter(),
    )

    assert syncer.run_once() == 0
    saved = json.loads(cursor_path.read_text())
    assert saved["log_offset"] < log_path.stat().st_size


def test_writer_error_does_not_mark_turn_synced(tmp_path):
    log_path = tmp_path / "agent.log"
    db_path = tmp_path / "state.db"
    cursor_path = tmp_path / "cursor.json"
    _create_state_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES (?, ?, ?)",
            ("s1", "tui", 1.0),
        )
        conn.executemany(
            "INSERT INTO messages(id, session_id, role, content, timestamp, active) "
            "VALUES (?, ?, ?, ?, ?, 1)",
            [
                (1, "s1", "user", "你好", 10.0),
                (2, "s1", "assistant", "你好", 11.0),
            ],
        )
    log_path.write_text(
        "\n".join(
            [
                "2026-06-24 10:00:00,000 INFO [s1] agent.turn_context: "
                "conversation turn: session=s1 model=qwen provider=custom "
                "platform=tui history=0 msg='你好'",
                "2026-06-24 10:00:03,000 INFO [s1] agent.conversation_loop: "
                "Turn ended: reason=text_response(finish_reason=stop) model=qwen "
                "api_calls=1/60 budget=1/60 tool_turns=0 last_msg_role=assistant "
                "response_len=12 session=s1",
            ]
        )
    )

    syncer = HermesLogSyncer(
        log_path=log_path,
        state_db_path=db_path,
        cursor_path=cursor_path,
        writer=_FakeWriter(result="Error add failed"),
    )

    try:
        syncer.run_once()
    except RuntimeError as exc:
        assert "Error add failed" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")
    assert not cursor_path.exists()


def test_resolve_mcp_url_prefers_cli_then_env_then_config_file(tmp_path, monkeypatch):
    config_path = tmp_path / "memos-log-syncer.json"
    write_syncer_config(config_path, "https://configured.example.com/mcp")

    monkeypatch.setenv("MEMOS_MCP_URL", "https://env.example.com/mcp")

    assert resolve_mcp_url("https://cli.example.com/mcp", config_path) == (
        "https://cli.example.com/mcp"
    )
    assert resolve_mcp_url(None, config_path) == "https://env.example.com/mcp"

    monkeypatch.delenv("MEMOS_MCP_URL")

    assert resolve_mcp_url(None, config_path) == "https://configured.example.com/mcp"
    assert resolve_mcp_url(None, tmp_path / "missing.json") == DEFAULT_MCP_URL


def test_writer_uses_configured_remote_mcp_url():
    writer = MemosMCPWriter(url="https://memos.example.com/mcp")

    assert writer.url == "https://memos.example.com/mcp"


class _FakeWriter:
    def __init__(self, result: str = "ok") -> None:
        self.calls: list[dict[str, str]] = []
        self.processed_batches: list[tuple[list[str], str]] = []
        self.result = result

    def write_raw_turn(self, arguments: dict[str, str]) -> str:
        self.calls.append(arguments)
        return self.result

    def process_raw_turns(self, memory_ids: list[str], session_id: str) -> str:
        self.processed_batches.append((memory_ids, session_id))
        return f"Submitted {len(memory_ids)} raw conversation turns for scheduler processing"


def _create_state_db(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                started_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                timestamp REAL NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            )
            """
        )
