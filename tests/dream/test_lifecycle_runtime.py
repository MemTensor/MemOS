"""Opt-in plugin ownership, manual maintenance and cooperative worker shutdown."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from memos.dream.lifecycle import LIFECYCLE_METADATA_KEY, LifecycleError
from memos.dream.plugin import CommunityDreamPlugin
from memos.plugins import hooks
from memos.plugins.hook_defs import H


@pytest.fixture(autouse=True)
def restore_hooks():
    before = {key: list(value) for key, value in hooks._hooks.items()}
    hooks._hooks.clear()
    yield
    hooks._hooks.clear()
    hooks._hooks.update(before)


def test_disabled_lifecycle_has_no_backend_checks_worker_or_shared_mutation():
    plugin = CommunityDreamPlugin()
    plugin.on_load()
    context = {
        "shared": {"graph_db": SimpleNamespace(supports_atomic_lifecycle=False)},
        "configs": {},
    }
    plugin.init_components(context)
    assert "dream_lifecycle" not in context["shared"]
    assert plugin.lifecycle is None
    assert not hooks._hooks.get(H.SEARCH_COMPLETED)
    plugin.on_shutdown()
    assert not any(hooks._hooks.values())


def test_plugin_manual_quiet_cube_and_shutdown_remove_only_owned_hooks(graph, tmp_path):
    now = datetime.now(timezone.utc)
    item = str(uuid4())
    graph.add_node(
        item,
        "Synthetic quiet memory",
        {
            "source": "dream",
            "status": "activated",
            "created_at": (now - timedelta(days=30)).isoformat(),
        },
        user_name="quiet-cube",
    )

    def other(**kwargs):
        return None

    hooks.register_hook(H.ADD_AFTER, other)
    plugin = CommunityDreamPlugin()
    plugin.on_load()
    context = {
        "shared": {"graph_db": graph},
        "configs": {
            "dream_lifecycle": {
                "enabled": True,
                "cube_ids": ["quiet-cube"],
                "checkpoint_directory": str(tmp_path),
                "policy": {"half_life_seconds": 86400, "never_hit_grace_seconds": 0},
            }
        },
    }
    plugin.init_components(context)
    assert context["shared"]["dream_lifecycle"] is plugin.lifecycle.service
    report = plugin.lifecycle.run_maintenance("quiet-cube", now=now)
    assert report.archived == 1 and report.complete
    assert (
        graph.get_node(item, user_name="quiet-cube")["metadata"][LIFECYCLE_METADATA_KEY]["status"]
        == "archived"
    )
    plugin.init_components(context)
    assert len(hooks._hooks[H.SEARCH_COMPLETED]) == 1
    plugin.on_shutdown()
    assert hooks._hooks[H.ADD_AFTER] == [other]
    assert not hooks._hooks.get(H.SEARCH_COMPLETED)
    assert "dream_lifecycle" not in context["shared"]
    plugin.on_load()
    assert len(hooks._hooks[H.DREAM_EXECUTE]) == 1
    plugin.on_shutdown()


def test_enabled_unsupported_backend_fails_explicitly_without_registering_observers():
    plugin = CommunityDreamPlugin()
    plugin.on_load()
    with pytest.raises(LifecycleError, match="atomic"):
        plugin.init_components(
            {
                "shared": {"graph_db": SimpleNamespace(supports_atomic_lifecycle=False)},
                "configs": {"dream_lifecycle": {"enabled": True}},
            }
        )
    assert not hooks._hooks.get(H.SEARCH_COMPLETED)
    plugin.on_shutdown()


def test_periodic_runtime_checks_quiet_registered_scope_and_stops(graph, monkeypatch):
    import threading

    from memos.dream.lifecycle.runtime import DreamLifecycleRuntime, LifecycleRuntimeConfig

    now = datetime.now(timezone.utc)
    item = str(uuid4())
    graph.add_node(
        item,
        "Quiet",
        {
            "source": "dream",
            "status": "activated",
            "created_at": (now - timedelta(days=30)).isoformat(),
        },
        user_name="quiet-cube",
    )
    runtime = DreamLifecycleRuntime(
        graph,
        LifecycleRuntimeConfig(
            enabled=True,
            cube_ids=("quiet-cube",),
            interval_seconds=0.01,
            policy={"half_life_seconds": 86400, "never_hit_grace_seconds": 0},
        ),
    )
    finished = threading.Event()
    original = runtime.run_maintenance

    def run(*args, **kwargs):
        result = original(*args, **kwargs)
        finished.set()
        return result

    monkeypatch.setattr(runtime, "run_maintenance", run)
    runtime.start()
    assert finished.wait(timeout=5)
    assert runtime.shutdown(timeout=5)
    assert graph.get_node(item, user_name="quiet-cube")["metadata"]["status"] == "archived"
    assert not runtime.worker_alive


def test_shutdown_does_not_claim_inflight_manual_operation_stopped(graph, monkeypatch):
    import threading

    from memos.dream.lifecycle.runtime import DreamLifecycleRuntime, LifecycleRuntimeConfig

    runtime = DreamLifecycleRuntime(
        graph, LifecycleRuntimeConfig(enabled=True, cube_ids=("quiet-cube",))
    )
    entered, release = threading.Event(), threading.Event()
    original = graph.list_lifecycle_nodes

    def blocking_read(**kwargs):
        entered.set()
        assert release.wait(timeout=5)
        return original(**kwargs)

    monkeypatch.setattr(graph, "list_lifecycle_nodes", blocking_read)
    thread = threading.Thread(target=lambda: runtime.run_maintenance("quiet-cube"))
    thread.start()
    try:
        assert entered.wait(timeout=5)
        assert runtime.shutdown(timeout=0) is False
    finally:
        release.set()
        thread.join(timeout=5)
    assert runtime.shutdown(timeout=1) is True
