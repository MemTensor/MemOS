"""Concurrent cleanup reports one outcome without sharing raised tracebacks."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock

import pytest

from memos.exceptions import MemOSError
from memos.lifecycle import CloseState


def test_waiter_has_own_exception_and_original_cause(monkeypatch):
    state = CloseState()
    entered, release, waiting = Event(), Event(), Event()
    original = ValueError("resource failed")

    def cleanup():
        entered.set()
        assert release.wait(3)
        raise original

    with ThreadPoolExecutor(2) as pool:
        owner = pool.submit(state.close, cleanup)
        assert entered.wait(3)
        wait = state._attempt.done.wait

        def observed_wait():
            waiting.set()
            return wait(3)

        monkeypatch.setattr(state._attempt.done, "wait", observed_wait)
        waiter = pool.submit(state.close, Mock())
        try:
            assert waiting.wait(3)
        finally:
            release.set()
        with pytest.raises(ValueError) as first:
            owner.result(3)
        with pytest.raises(MemOSError) as second:
            waiter.result(3)
    assert first.value is original
    assert second.value is not original and second.value.__cause__ is original
    retry = Mock()
    state.close(retry)
    state.close(retry)
    retry.assert_called_once()
