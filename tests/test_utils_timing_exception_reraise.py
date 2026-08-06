"""Test that timed_with_status re-raises exceptions when no fallback is configured.

Regression test for issue #1523: timed_with_status decorator silently swallowed
exceptions and returned None when no fallback was provided, masking real errors.
"""

import pytest

from memos.utils import timed_with_status


class TestTimedWithStatusExceptionReraise:
    """Verify that exceptions are re-raised when no fallback is configured."""

    def test_exception_reraised_when_no_fallback(self):
        """When no fallback is configured, exceptions should propagate to caller."""

        @timed_with_status(log_prefix="test_func")
        def failing_func():
            raise ValueError("upstream error")

        with pytest.raises(ValueError, match="upstream error"):
            failing_func()

    def test_exception_reraised_preserves_type(self):
        """The re-raised exception should preserve its original type."""

        class CustomError(Exception):
            pass

        @timed_with_status()
        def custom_error_func():
            raise CustomError("specific error")

        with pytest.raises(CustomError, match="specific error"):
            custom_error_func()

    def test_fallback_still_works(self):
        """When fallback is provided, it should still be called instead of re-raising."""

        @timed_with_status(fallback=lambda exc, *args, **kwargs: "fallback_result")
        def failing_with_fallback():
            raise RuntimeError("error")

        result = failing_with_fallback()
        assert result == "fallback_result"

    def test_no_implicit_none_return(self):
        """Decorated function should never return None on exception without fallback."""

        @timed_with_status()
        def fail_and_return():
            raise KeyError("missing key")

        # Should raise, not return None
        with pytest.raises(KeyError):
            result = fail_and_return()
            # This line should never execute
            assert result is not None, "Function returned None instead of raising"
