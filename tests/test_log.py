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
