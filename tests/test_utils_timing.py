"""Tests for memos.utils timing utilities: timed_stage, timed, timed_with_status.

Covers:
  - timed_stage: context-manager, decorator, emit_now, duration_ms propagation,
    set(), error logging, extra callback, static extra dict
  - timed: regression (return value, threshold, log_prefix, log=False)
  - timed_with_status: regression (success, failure+fallback, log_args, log_extra_args)
"""

import logging
import time

import pytest

from memos.utils import timed, timed_stage, timed_with_status


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _collect_stage_logs(caplog):
    """Return all log messages that start with '[STAGE]'."""
    return [r.message for r in caplog.records if r.message.startswith("[STAGE]")]


def _collect_timer_logs(caplog):
    """Return all log messages that start with '[TIMER]'."""
    return [r.message for r in caplog.records if r.message.startswith("[TIMER]")]


def _collect_timer_with_status_logs(caplog):
    """Return all log messages that start with '[TIMER_WITH_STATUS]'."""
    return [r.message for r in caplog.records if r.message.startswith("[TIMER_WITH_STATUS]")]


# ===========================================================================
# timed_stage — context manager
# ===========================================================================


class TestTimedStageContextManager:
    def test_basic_log_output(self, caplog):
        with caplog.at_level(logging.INFO), timed_stage("add", "parse", cube_id="c1"):
            pass
        logs = _collect_stage_logs(caplog)
        assert len(logs) == 1
        assert "biz=add" in logs[0]
        assert "stage=parse" in logs[0]
        assert "cube_id=c1" in logs[0]
        assert "duration_ms=" in logs[0]

    def test_duration_ms_is_populated(self, caplog):
        with caplog.at_level(logging.INFO), timed_stage("add", "embedding") as ts:
            time.sleep(0.05)
        assert ts.duration_ms >= 40  # at least ~50ms minus jitter

    def test_set_adds_fields(self, caplog):
        with caplog.at_level(logging.INFO), timed_stage("add", "write_db") as ts:
            ts.set(memory_count=7)
        logs = _collect_stage_logs(caplog)
        assert "memory_count=7" in logs[0]

    def test_set_overwrites_fields(self, caplog):
        with caplog.at_level(logging.INFO), timed_stage("add", "write_db", memory_count=0) as ts:
            ts.set(memory_count=5)
        logs = _collect_stage_logs(caplog)
        assert "memory_count=5" in logs[0]
        assert "memory_count=0" not in logs[0]

    def test_exception_logged_but_propagated(self, caplog):
        with (
            caplog.at_level(logging.INFO),
            pytest.raises(ValueError, match="boom"),
            timed_stage("add", "parse"),
        ):
            raise ValueError("boom")
        logs = _collect_stage_logs(caplog)
        assert len(logs) == 1
        assert "error=ValueError" in logs[0]

    def test_duration_ms_available_after_exception(self, caplog):
        with caplog.at_level(logging.INFO):
            ts = timed_stage("add", "parse")
            with pytest.raises(RuntimeError), ts:
                time.sleep(0.02)
                raise RuntimeError("fail")
        assert ts.duration_ms >= 15

    def test_no_biz_no_stage(self, caplog):
        """Empty biz/stage should not emit those fields."""
        with caplog.at_level(logging.INFO), timed_stage(x=1):
            pass
        logs = _collect_stage_logs(caplog)
        assert "biz=" not in logs[0]
        assert "stage=" not in logs[0]
        assert "x=1" in logs[0]

    def test_duration_ms_readable_downstream(self):
        """Downstream code can reference ts.duration_ms for summary rollup."""
        with timed_stage("add", "get_memory") as ts:
            time.sleep(0.01)
        get_memory_ms = ts.duration_ms
        assert isinstance(get_memory_ms, int)
        assert get_memory_ms >= 5


# ===========================================================================
# timed_stage — decorator
# ===========================================================================


class TestTimedStageDecorator:
    def test_decorator_basic(self, caplog):
        @timed_stage("search", "recall")
        def do_recall():
            return [1, 2, 3]

        with caplog.at_level(logging.INFO):
            result = do_recall()
        assert result == [1, 2, 3]
        logs = _collect_stage_logs(caplog)
        assert len(logs) == 1
        assert "biz=search" in logs[0]
        assert "stage=recall" in logs[0]

    def test_decorator_uses_func_name_when_no_stage(self, caplog):
        @timed_stage("add")
        def my_custom_func():
            pass

        with caplog.at_level(logging.INFO):
            my_custom_func()
        logs = _collect_stage_logs(caplog)
        assert "stage=my_custom_func" in logs[0]

    def test_decorator_preserves_function_metadata(self):
        @timed_stage("add", "test")
        def documented_func():
            """I have a docstring."""
            return 42

        assert documented_func.__name__ == "documented_func"
        assert documented_func.__doc__ == "I have a docstring."

    def test_decorator_with_extra_callback(self, caplog):
        class Service:
            cube_id = "cube_abc"

            @timed_stage("add", "write_db", extra=lambda self: {"cube_id": self.cube_id})
            def write(self):
                return "ok"

        svc = Service()
        with caplog.at_level(logging.INFO):
            result = svc.write()
        assert result == "ok"
        logs = _collect_stage_logs(caplog)
        assert "cube_id=cube_abc" in logs[0]

    def test_decorator_extra_callback_error_does_not_break(self, caplog):
        @timed_stage("add", "risky", extra=lambda: (_ for _ in ()).throw(RuntimeError("oops")))
        def risky_func():
            return "still works"

        with caplog.at_level(logging.WARNING):
            result = risky_func()
        assert result == "still works"

    def test_decorator_exception_propagated(self, caplog):
        @timed_stage("add", "crash")
        def crasher():
            raise TypeError("type error")

        with caplog.at_level(logging.INFO), pytest.raises(TypeError, match="type error"):
            crasher()
        logs = _collect_stage_logs(caplog)
        assert "error=TypeError" not in logs[0]  # decorator path doesn't pass exc_type


# ===========================================================================
# timed_stage.emit_now
# ===========================================================================


class TestTimedStageEmitNow:
    def test_emit_now_basic(self, caplog):
        with caplog.at_level(logging.INFO):
            timed_stage.emit_now("add", "summary", total_ms=1200, per_item_ms=240)
        logs = _collect_stage_logs(caplog)
        assert len(logs) == 1
        assert "biz=add" in logs[0]
        assert "stage=summary" in logs[0]
        assert "total_ms=1200" in logs[0]
        assert "per_item_ms=240" in logs[0]
        assert "duration_ms" not in logs[0]

    def test_emit_now_no_extra_fields(self, caplog):
        with caplog.at_level(logging.INFO):
            timed_stage.emit_now("search", "summary")
        logs = _collect_stage_logs(caplog)
        assert logs[0] == "[STAGE] biz=search stage=summary"


# ===========================================================================
# timed_stage — static extra dict
# ===========================================================================


class TestTimedStageStaticExtra:
    def test_static_extra_dict(self, caplog):
        with caplog.at_level(logging.INFO), timed_stage("add", "parse", extra={"env": "prod"}):
            pass
        logs = _collect_stage_logs(caplog)
        assert "env=prod" in logs[0]


# ===========================================================================
# timed — regression tests (original behavior must not change)
# ===========================================================================


class TestTimedRegression:
    def test_return_value_preserved(self):
        @timed
        def add(a, b):
            return a + b

        assert add(1, 2) == 3

    def test_no_log_below_threshold(self, caplog):
        """@timed only logs when elapsed >= 100ms."""

        @timed
        def fast_func():
            return "fast"

        with caplog.at_level(logging.INFO):
            result = fast_func()
        assert result == "fast"
        logs = _collect_timer_logs(caplog)
        assert len(logs) == 0

    def test_log_above_threshold(self, caplog):
        @timed
        def slow_func():
            time.sleep(0.12)
            return "slow"

        with caplog.at_level(logging.INFO):
            result = slow_func()
        assert result == "slow"
        logs = _collect_timer_logs(caplog)
        assert len(logs) == 1
        assert "slow_func" in logs[0]

    def test_log_false_disables(self, caplog):
        @timed(log=False)
        def no_log_func():
            time.sleep(0.12)
            return 99

        with caplog.at_level(logging.INFO):
            result = no_log_func()
        assert result == 99
        logs = _collect_timer_logs(caplog)
        assert len(logs) == 0

    def test_log_prefix(self, caplog):
        @timed(log_prefix="MY_PREFIX")
        def prefixed():
            time.sleep(0.12)
            return True

        with caplog.at_level(logging.INFO):
            prefixed()
        logs = _collect_timer_logs(caplog)
        assert "MY_PREFIX" in logs[0]

    def test_both_decorator_forms(self):
        """@timed and @timed() should both work."""

        @timed
        def bare():
            return 1

        @timed()
        def parens():
            return 2

        assert bare() == 1
        assert parens() == 2


# ===========================================================================
# timed_with_status — regression tests
# ===========================================================================


class TestTimedWithStatusRegression:
    def test_success_logging(self, caplog):
        @timed_with_status
        def ok_func():
            return "hello"

        with caplog.at_level(logging.INFO):
            result = ok_func()
        assert result == "hello"
        logs = _collect_timer_with_status_logs(caplog)
        assert len(logs) == 1
        assert "status: SUCCESS" in logs[0]
        assert "ok_func" in logs[0]

    def test_failure_logging_no_fallback(self, caplog):
        @timed_with_status
        def fail_func():
            raise RuntimeError("bad")

        with caplog.at_level(logging.INFO):
            fail_func()
        logs = _collect_timer_with_status_logs(caplog)
        assert len(logs) == 1
        assert "status: FAILED" in logs[0]
        assert "RuntimeError" in logs[0]

    def test_failure_with_fallback(self, caplog):
        @timed_with_status(fallback=lambda e, *a, **kw: "fallback_val")
        def fail_func():
            raise RuntimeError("bad")

        with caplog.at_level(logging.INFO):
            result = fail_func()
        assert result == "fallback_val"
        logs = _collect_timer_with_status_logs(caplog)
        assert "status: FAILED" in logs[0]

    def test_log_prefix(self, caplog):
        @timed_with_status(log_prefix="CUSTOM")
        def prefixed():
            return 1

        with caplog.at_level(logging.INFO):
            prefixed()
        logs = _collect_timer_with_status_logs(caplog)
        assert "CUSTOM" in logs[0]

    def test_log_args(self, caplog):
        @timed_with_status(log_args=["user_id"])
        def with_args(user_id="u1"):
            return user_id

        with caplog.at_level(logging.INFO):
            with_args(user_id="u42")
        logs = _collect_timer_with_status_logs(caplog)
        assert "user_id=u42" in logs[0]

    def test_log_extra_args_dict(self, caplog):
        @timed_with_status(log_extra_args={"region": "us-west"})
        def with_extra():
            return True

        with caplog.at_level(logging.INFO):
            with_extra()
        logs = _collect_timer_with_status_logs(caplog)
        assert "region=us-west" in logs[0]

    def test_log_extra_args_callable(self, caplog):
        @timed_with_status(log_extra_args=lambda *a, **kw: {"dynamic": "yes"})
        def with_dynamic():
            return True

        with caplog.at_level(logging.INFO):
            with_dynamic()
        logs = _collect_timer_with_status_logs(caplog)
        assert "dynamic=yes" in logs[0]

    def test_both_decorator_forms(self):
        """@timed_with_status and @timed_with_status() should both work."""

        @timed_with_status
        def bare():
            return 1

        @timed_with_status()
        def parens():
            return 2

        assert bare() == 1
        assert parens() == 2
