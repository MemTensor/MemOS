"""Legacy process handles are retained until cleanup succeeds.

Independent process execution and draining are covered in test_worker_isolation.
"""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.exceptions import MemOSError
from memos.mem_scheduler.base_mixins.queue_ops import BaseSchedulerQueueMixin
from memos.mem_scheduler.base_scheduler import BaseScheduler


@pytest.mark.parametrize("failure", ["survives", "terminate_error"])
def test_unterminated_process_keeps_resources_and_allows_retry(failure):
    scheduler = BaseScheduler({"use_redis_queue": False, "thread_pool_max_workers": 1})
    graph = Mock()
    scheduler.components = {"graph_db": graph}
    process = Mock(is_alive=Mock(return_value=True))
    if failure == "terminate_error":
        process.terminate.side_effect = OSError("cannot terminate")
    scheduler._consumer_process = process
    try:
        with pytest.raises(MemOSError):
            scheduler.close()
        process.terminate.assert_called_once()
        graph.close.assert_not_called()
        assert not scheduler.dispatcher.dispatcher_executor._shutdown
    finally:
        process.is_alive.return_value = False
        scheduler.close()
    graph.close.assert_called_once()


def test_starting_running_consumer_does_not_replace_stop_signal():
    owner = SimpleNamespace(_running=True)
    BaseSchedulerQueueMixin.start_consumer(owner)
    assert vars(owner) == {"_running": True}
