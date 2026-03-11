"""DemoPlugin hook callback verification — including @hookable before/after and custom trigger_hook."""

import logging

from fastapi import FastAPI


logging.basicConfig(level=logging.DEBUG)


def _init_plugin(plugin, app):
    plugin._bind_app(app)
    plugin.init_app()


def _make_plugin():
    from memos_demo_plugin.plugin import DemoPlugin

    app = FastAPI()
    plugin = DemoPlugin()
    plugin.on_load()
    _init_plugin(plugin, app)
    return plugin


class TestHookCallbacks:
    """Verify business logic of each hook callback in the Demo plugin."""

    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_add_after_counts(self):
        from memos.plugins.hooks import trigger_hook

        plugin = _make_plugin()

        class Req:
            user_id = "alice"

        trigger_hook("add.after", request=Req(), result={})
        trigger_hook("add.after", request=Req(), result={})

        assert plugin.add_counter["alice"] == 2

    def test_add_before_logs(self):
        from memos.plugins.hooks import trigger_hook

        plugin = _make_plugin()

        class Req:
            user_id = "bob"

        trigger_hook("add.before", request=Req())

        assert len(plugin.request_log) == 1
        assert plugin.request_log[0]["user_id"] == "bob"

    def test_search_before_logs(self):
        from memos.plugins.hooks import trigger_hook

        plugin = _make_plugin()

        class Req:
            user_id = "charlie"

        trigger_hook("search.before", request=Req())

        assert len(plugin.request_log) == 1
        assert plugin.request_log[0]["user_id"] == "charlie"

    def test_multiple_users(self):
        from memos.plugins.hooks import trigger_hook

        plugin = _make_plugin()

        class ReqA:
            user_id = "alice"

        class ReqB:
            user_id = "bob"

        trigger_hook("add.before", request=ReqA())
        trigger_hook("add.after", request=ReqA(), result={})
        trigger_hook("add.before", request=ReqB())
        trigger_hook("add.after", request=ReqB(), result={})
        trigger_hook("add.before", request=ReqA())
        trigger_hook("add.after", request=ReqA(), result={})

        assert plugin.add_counter == {"alice": 2, "bob": 1}
        assert len(plugin.request_log) == 3

    def test_post_process_hook_is_pipeline(self):
        """add.memories.post_process is a pipeline-style hook; callbacks can modify and return result."""
        from memos.plugins.hook_defs import H
        from memos.plugins.hooks import trigger_hook

        plugin = _make_plugin()

        class Req:
            user_id = "dave"

        original = [{"id": 1}, {"id": 2}]
        rv = trigger_hook(H.ADD_MEMORIES_POST_PROCESS, request=Req(), result=original)

        assert rv is original
        assert len(plugin.post_process_log) == 1
        assert plugin.post_process_log[0]["user_id"] == "dave"
        assert plugin.post_process_log[0]["result_count"] == 2
