import logging
import os

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
