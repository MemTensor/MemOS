import logging
import time

from unittest.mock import MagicMock, patch

import pytest
import requests

from dotenv import load_dotenv

from memos import log


load_dotenv()


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


@pytest.fixture
def mock_env(monkeypatch):
    monkeypatch.setenv("CUSTOM_LOGGER_URL", "http://mock-logger.com/logs")
    monkeypatch.setenv("CUSTOM_LOGGER_TOKEN", "test-token")
    monkeypatch.setenv("CUSTOM_LOGGER_WORKERS", "2")


def test_custom_logger_async_logging(mock_env):
    """Test asynchronous log reporting functionality of the custom logger handler"""
    from memos.api.context.context import RequestContext, set_request_context

    # Create and set request context
    context = RequestContext(trace_id="test-trace-id")
    set_request_context(context)

    with patch("requests.Session.post") as mock_post:
        mock_post.side_effect = lambda *args, **kwargs: MagicMock(status_code=200)

        logger = log.get_logger("test_async_logger")
        start_time = time.time()

        # Send multiple log messages
        for i in range(3):
            logger.info(f"Test log message {i}")

        # Verify logging is asynchronous
        assert time.time() - start_time < 0.1, "Log sending should be non-blocking"

        # Wait for async tasks to complete
        time.sleep(0.1)

        # Verify log sending
        assert mock_post.call_count == 3
        last_call = mock_post.call_args
        assert last_call.kwargs["headers"]["Content-Type"] == "application/json"
        assert last_call.kwargs["headers"]["Authorization"] == "Bearer test-token"
        assert "message" in last_call.kwargs["json"]
        assert last_call.kwargs["json"]["trace_id"] == "test-trace-id"


def test_custom_logger_error_handling(mock_env):
    """Test error handling capabilities of the custom logger handler"""
    from memos.api.context.context import RequestContext, set_request_context

    # Create and set request context
    context = RequestContext(trace_id="test-trace-id")
    set_request_context(context)

    with patch("requests.Session.post") as mock_post:
        mock_post.side_effect = requests.exceptions.RequestException()
        logger = log.get_logger("test_error_logger")

        # Log sending should not raise exceptions
        logger.info("Test log message")
        time.sleep(0.1)

        # Verify that log sending was attempted even with errors
        assert mock_post.called


def test_custom_logger_shutdown(mock_env):
    """Test shutdown behavior of the custom logger handler"""
    from memos.api.context.context import RequestContext, set_request_context

    # Create and set request context
    context = RequestContext(trace_id="test-trace-id")
    set_request_context(context)

    logger_handler = log.CustomLoggerRequestHandler()
    logger_handler._cleanup()

    with patch("requests.Session.post") as mock_post:
        logger = log.get_logger("test_shutdown_logger")
        logger.info("Test log after shutdown")
        mock_post.assert_not_called()
