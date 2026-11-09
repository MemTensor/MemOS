"""Every failed owned resource remains observable and retryable."""

from unittest.mock import Mock

import pytest

from memos.lifecycle import CloseState
from memos.mem_cube.general import GeneralMemCube


def test_multiple_cleanup_failures_are_logged_and_only_failures_retry(monkeypatch):
    log = Mock()
    monkeypatch.setattr("memos.mem_cube.general.logger", log)
    first, second = ValueError("first failure"), OSError("second failure")
    memories = [
        Mock(close=Mock(side_effect=[first, None])),
        Mock(),
        Mock(close=Mock(side_effect=[second, None])),
    ]
    cube = GeneralMemCube.__new__(GeneralMemCube)
    cube._close_state = CloseState()
    cube._owned_memories = list(memories)
    with pytest.raises(ValueError) as caught:
        cube.close()
    assert caught.value is first
    assert log.exception.call_count == 2
    assert cube._owned_memories == [memories[0], memories[2]]
    cube.close()
    assert [m.close.call_count for m in memories] == [2, 1, 2]
    assert cube._owned_memories == []
