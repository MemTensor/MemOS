"""Shutdown reads a component Mapping; lifecycle state belongs to each resource."""

from types import MappingProxyType, SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.api.lifecycle import shutdown_components
from memos.exceptions import MemOSError


@pytest.mark.parametrize("readonly", [False, True])
@pytest.mark.parametrize("scheduler_present", [False, True])
def test_shutdown_does_not_modify_component_mapping(readonly, scheduler_present):
    order = []
    graph = Mock(close=Mock(side_effect=lambda: order.append("graph")))
    scheduler = Mock(close=Mock(side_effect=lambda: order.append("scheduler")))
    components = {"graph_db": graph}
    if scheduler_present:
        components["mem_scheduler"] = scheduler
    before = dict(components)
    shutdown_components(MappingProxyType(components) if readonly else components)
    assert components == before
    assert order == (["scheduler", "graph"] if scheduler_present else ["graph"])


def test_api_delegates_repeat_safety_to_resources():
    graph, scheduler = Mock(), Mock()
    components = MappingProxyType({"graph_db": graph, "mem_scheduler": scheduler})
    shutdown_components(components)
    shutdown_components(components)
    assert scheduler.close.call_count == graph.close.call_count == 2


def test_failed_scheduler_keeps_graph_open_then_retry_delegates():
    scheduler = Mock(close=Mock(side_effect=[MemOSError("busy"), None]))
    graph = Mock()
    components = MappingProxyType({"mem_scheduler": scheduler, "graph_db": graph})
    with pytest.raises(MemOSError):
        shutdown_components(components)
    graph.close.assert_not_called()
    shutdown_components(components)
    graph.close.assert_called_once()


def test_legacy_without_close_still_stops_before_graph():
    order = []
    scheduler = SimpleNamespace(
        stop=lambda: order.append("stop"), rabbitmq_close=lambda: order.append("rabbitmq")
    )
    graph = SimpleNamespace(close=lambda: order.append("graph"))
    shutdown_components(MappingProxyType({"mem_scheduler": scheduler, "graph_db": graph}))
    assert order == ["stop", "rabbitmq", "graph"]


def test_legacy_rabbitmq_failure_does_not_close_graph():
    from types import SimpleNamespace

    scheduler = SimpleNamespace(stop=Mock(), rabbitmq_close=Mock(side_effect=ValueError("drain")))
    graph = Mock()
    with pytest.raises(MemOSError):
        shutdown_components({"mem_scheduler": scheduler, "graph_db": graph})
    graph.close.assert_not_called()
