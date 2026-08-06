import logging
import os

from types import SimpleNamespace

from dotenv import load_dotenv

from memos import log


load_dotenv()


def generate_trace_id() -> str:
    """Generate a random trace_id."""
    return os.urandom(16).hex()


def test_setup_logfile_creates_file(tmp_path, monkeypatch):
    monkeypatch.setattr("memos.settings.MEMOS_DIR", tmp_path)
    path = log._setup_logfile()
    assert path.exists()
    assert path.name == "memos.log"


def test_get_logger_returns_logger():
    logger = log.get_logger("test_logger")
    assert isinstance(logger, logging.Logger)
    assert logger.name == "test_logger"
    assert any(isinstance(h, logging.StreamHandler) for h in logger.parent.handlers) or any(
        isinstance(h, logging.FileHandler) for h in logger.parent.handlers
    )


def test_get_logger_configures_logging_once_per_process(monkeypatch):
    calls = []

    monkeypatch.setattr(log, "_LOGGING_CONFIGURED_PID", None)
    monkeypatch.setattr(log, "_get_current_pid", lambda: 123)
    monkeypatch.setattr(log, "dictConfig", lambda config: calls.append(config))

    log.get_logger("first")
    log.get_logger("second")

    assert len(calls) == 1


def test_get_logger_reconfigures_after_process_fork(monkeypatch):
    calls = []
    pid = 123

    def getpid():
        return pid

    monkeypatch.setattr(log, "_LOGGING_CONFIGURED_PID", None)
    monkeypatch.setattr(log, "_get_current_pid", getpid)
    monkeypatch.setattr(log, "dictConfig", lambda config: calls.append(config))

    log.get_logger("parent")
    pid = 456
    log.get_logger("child")

    assert len(calls) == 2


def test_summarize_search_request_uses_metadata_and_query_hash_only():
    request = SimpleNamespace(
        query="private query content",
        user_id="private-user",
        mode="fast",
        readable_cube_ids=["cube-a", "cube-b"],
        include_memory_view=["detail_factual", "preference"],
        memory_limit_number=6,
        dedup="mmr",
        rerank=True,
    )

    summary = log.summarize_search_request(request)

    assert summary["query_chars"] == len(request.query)
    assert len(summary["query_hash"]) == 16
    assert summary["mode"] == "fast"
    assert summary["readable_cube_count"] == 2
    assert summary["views"] == ["detail_factual", "preference"]
    assert summary["top_k"] == 6
    assert summary["dedup"] == "mmr"
    assert summary["rerank"] is True
    assert request.query not in str(summary)
    assert request.user_id not in str(summary)


def test_summarize_search_results_only_counts_buckets_and_items():
    results = {
        "text_mem": [
            {
                "cube_id": "cube-a",
                "memories": [
                    {
                        "memory": "private memory value",
                        "metadata": {
                            "embedding": [0.1] * 256,
                            "properties": {"secret": 1},
                        },
                    },
                    {"memory": "another private value"},
                ],
            }
        ],
        "pref_mem": [{"cube_id": "cube-a", "memories": [{"memory": "private preference"}]}],
        "skill_mem": [],
        "pref_note": "private preference note",
    }

    summary = log.summarize_search_results(results)

    assert summary == {
        "bucket_counts": {"text_mem": 1, "pref_mem": 1, "skill_mem": 0},
        "item_counts": {"text_mem": 2, "pref_mem": 1, "skill_mem": 0},
        "total_items": 3,
    }
    rendered = str(summary)
    assert "private memory value" not in rendered
    assert "0.1" not in rendered
    assert "secret" not in rendered
    assert "private preference note" not in rendered
    assert len(rendered) <= len(str(results)) * 0.2


def test_summarize_textual_memories_only_counts_types():
    memories = [
        SimpleNamespace(
            memory="private long-term memory",
            metadata=SimpleNamespace(
                memory_type="LongTermMemory",
                embedding=[0.1, 0.2],
            ),
        ),
        SimpleNamespace(
            memory="private user memory",
            metadata=SimpleNamespace(
                memory_type="UserMemory",
                properties={"secret": True},
            ),
        ),
    ]

    summary = log.summarize_textual_memories(memories)

    assert summary == {
        "total_items": 2,
        "type_counts": {"LongTermMemory": 1, "UserMemory": 1},
    }
    rendered = str(summary)
    assert "private long-term memory" not in rendered
    assert "0.1" not in rendered
    assert "secret" not in rendered
