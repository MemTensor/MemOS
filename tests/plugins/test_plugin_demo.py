"""
Plugin system core framework tests.

Covers generic capabilities of the memos.plugins package (independent of specific plugin implementations):
1. Hook declaration registry (hook_defs)
2. Hook registration and triggering / pipe_key pipeline return value
3. @hookable decorator (sync + async + auto-declaration + pipeline return value)
4. MemOSPlugin base class register_* methods

Plugin-specific functional tests are located in each plugin package:
  extensions/memos_demo_plugin/tests/
"""

import asyncio
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient


logging.basicConfig(level=logging.DEBUG)


# ========================================================================= #
#  1. Hook declaration registry (hook_defs)
# ========================================================================= #


class TestHookDefs:
    def test_define_hook_and_get_spec(self):
        from memos.plugins.hook_defs import define_hook, get_hook_spec

        define_hook(
            "test.custom.hook",
            description="test hook",
            params=["request", "result"],
            pipe_key="result",
        )

        spec = get_hook_spec("test.custom.hook")
        assert spec is not None
        assert spec.name == "test.custom.hook"
        assert spec.params == ["request", "result"]
        assert spec.pipe_key == "result"

    def test_define_hook_is_idempotent(self):
        from memos.plugins.hook_defs import define_hook, get_hook_spec

        define_hook("test.idempotent", description="first", params=["a"], pipe_key="a")
        define_hook("test.idempotent", description="second", params=["b"], pipe_key="b")

        spec = get_hook_spec("test.idempotent")
        assert spec.description == "first"

    def test_get_hook_spec_returns_none_for_unknown(self):
        from memos.plugins.hook_defs import get_hook_spec

        assert get_hook_spec("definitely.does.not.exist") is None

    def test_all_hook_specs_includes_custom(self):
        from memos.plugins.hook_defs import H, all_hook_specs

        specs = all_hook_specs()
        assert H.ADD_MEMORIES_POST_PROCESS in specs

    def test_h_constants(self):
        from memos.plugins.hook_defs import H

        assert H.ADD_BEFORE == "add.before"
        assert H.ADD_AFTER == "add.after"
        assert H.SEARCH_BEFORE == "search.before"
        assert H.SEARCH_AFTER == "search.after"
        assert H.ADD_MEMORIES_POST_PROCESS == "add.memories.post_process"


# ========================================================================= #
#  2. Hook registration and triggering / pipe_key pipeline return value
# ========================================================================= #


class TestHookMechanism:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_register_and_trigger(self):
        from memos.plugins.hooks import register_hook, trigger_hook

        captured = {}

        def my_callback(*, request, **kwargs):
            captured["request"] = request

        register_hook("add.before", my_callback)
        trigger_hook("add.before", request="test_request")

        assert captured["request"] == "test_request"

    def test_register_hooks_batch(self):
        from memos.plugins.hooks import register_hooks, trigger_hook

        call_count = 0

        def my_callback(**kwargs):
            nonlocal call_count
            call_count += 1

        register_hooks(["add.before", "search.before"], my_callback)
        trigger_hook("add.before")
        trigger_hook("search.before")

        assert call_count == 2

    def test_trigger_undeclared_hook_returns_none(self):
        from memos.plugins.hooks import trigger_hook

        result = trigger_hook("nonexistent.undeclared.hook", request="anything")
        assert result is None

    def test_hook_exception_does_not_propagate(self):
        from memos.plugins.hook_defs import define_hook
        from memos.plugins.hooks import register_hook, trigger_hook

        define_hook("test.exception", description="test", params=["x"])

        results = []

        def bad_callback(**kwargs):
            raise ValueError("intentional error")

        def good_callback(**kwargs):
            results.append("ok")

        register_hook("test.exception", bad_callback)
        register_hook("test.exception", good_callback)
        trigger_hook("test.exception", x=1)

        assert results == ["ok"]

    def test_trigger_hook_pipe_key_returns_modified_value(self):
        from memos.plugins.hook_defs import define_hook
        from memos.plugins.hooks import register_hook, trigger_hook

        define_hook(
            "test.pipe",
            description="pipe test",
            params=["request", "result"],
            pipe_key="result",
        )

        def double_result(*, request, result, **kwargs):
            return result * 2

        register_hook("test.pipe", double_result)
        rv = trigger_hook("test.pipe", request="req", result=5)

        assert rv == 10

    def test_trigger_hook_pipe_key_chains_callbacks(self):
        from memos.plugins.hook_defs import define_hook
        from memos.plugins.hooks import register_hook, trigger_hook

        define_hook(
            "test.chain",
            description="chain test",
            params=["result"],
            pipe_key="result",
        )

        def add_one(*, result, **kwargs):
            return result + 1

        def add_ten(*, result, **kwargs):
            return result + 10

        register_hook("test.chain", add_one)
        register_hook("test.chain", add_ten)

        rv = trigger_hook("test.chain", result=0)
        assert rv == 11

    def test_trigger_hook_pipe_key_none_callback_no_modify(self):
        from memos.plugins.hook_defs import define_hook
        from memos.plugins.hooks import register_hook, trigger_hook

        define_hook(
            "test.noop",
            description="noop test",
            params=["result"],
            pipe_key="result",
        )

        def noop(*, result, **kwargs):
            return None  # explicitly return None — should not modify

        register_hook("test.noop", noop)
        rv = trigger_hook("test.noop", result="original")

        assert rv == "original"

    def test_trigger_hook_notification_mode(self):
        from memos.plugins.hook_defs import define_hook
        from memos.plugins.hooks import register_hook, trigger_hook

        define_hook(
            "test.notify",
            description="notification test",
            params=["data"],
            pipe_key=None,
        )

        captured = []

        def observer(*, data, **kwargs):
            captured.append(data)

        register_hook("test.notify", observer)
        rv = trigger_hook("test.notify", data="hello")

        assert rv is None
        assert captured == ["hello"]


# ========================================================================= #
#  3. @hookable decorator
# ========================================================================= #


class TestHookableDecorator:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_hookable_auto_declares_specs(self):
        from memos.plugins.hook_defs import get_hook_spec
        from memos.plugins.hooks import hookable

        @hookable("auto_test")
        def dummy(self, request):
            return request

        before_spec = get_hook_spec("auto_test.before")
        after_spec = get_hook_spec("auto_test.after")

        assert before_spec is not None
        assert before_spec.pipe_key == "request"
        assert after_spec is not None
        assert after_spec.pipe_key == "result"

    def test_hookable_sync(self):
        from memos.plugins.hooks import hookable, register_hook

        events = []

        def on_before(*, request, **kwargs):
            events.append(("before", request))

        def on_after(*, request, result, **kwargs):
            events.append(("after", result))

        register_hook("sync_demo.before", on_before)
        register_hook("sync_demo.after", on_after)

        class FakeHandler:
            @hookable("sync_demo")
            def do_work(self, request):
                return f"processed:{request}"

        result = FakeHandler().do_work("my_input")

        assert result == "processed:my_input"
        assert events == [("before", "my_input"), ("after", "processed:my_input")]

    def test_hookable_async(self):
        from memos.plugins.hooks import hookable, register_hook

        events = []

        def on_before(*, request, **kwargs):
            events.append("before")

        def on_after(*, request, result, **kwargs):
            events.append("after")

        register_hook("async_demo.before", on_before)
        register_hook("async_demo.after", on_after)

        class FakeHandler:
            @hookable("async_demo")
            async def do_work(self, request):
                return "async_result"

        result = asyncio.run(FakeHandler().do_work("req"))

        assert result == "async_result"
        assert events == ["before", "after"]

    def test_hookable_before_can_modify_request(self):
        from memos.plugins.hooks import hookable, register_hook

        def rewrite_request(*, request, **kwargs):
            return "modified_request"

        register_hook("modify_req.before", rewrite_request)

        class FakeHandler:
            @hookable("modify_req")
            def do_work(self, request):
                return f"got:{request}"

        result = FakeHandler().do_work("original")
        assert result == "got:modified_request"

    def test_hookable_after_can_modify_result(self):
        from memos.plugins.hooks import hookable, register_hook

        def rewrite_result(*, request, result, **kwargs):
            return f"{result}+modified"

        register_hook("modify_res.after", rewrite_result)

        class FakeHandler:
            @hookable("modify_res")
            def do_work(self, request):
                return "original_result"

        result = FakeHandler().do_work("req")
        assert result == "original_result+modified"

    def test_hookable_falsy_return_preserved(self):
        """ensure empty list / 0 / empty string are not treated as None"""
        from memos.plugins.hooks import hookable, register_hook

        def return_empty_list(*, request, result, **kwargs):
            return []

        register_hook("falsy_test.after", return_empty_list)

        class FakeHandler:
            @hookable("falsy_test")
            def do_work(self, request):
                return [1, 2, 3]

        result = FakeHandler().do_work("req")
        assert result == []


# ========================================================================= #
#  4. Base class register_* methods
# ========================================================================= #


class TestBaseClassRegisterMethods:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_register_router(self):
        from fastapi import APIRouter

        from memos.plugins.base import MemOSPlugin

        app = FastAPI()
        plugin = MemOSPlugin()
        plugin._bind_app(app)

        router = APIRouter(prefix="/test")

        @router.get("/ping")
        async def ping():
            return {"pong": True}

        plugin.register_router(router)

        paths = [r.path for r in app.routes]
        assert "/test/ping" in paths

    def test_register_middleware(self):
        from starlette.middleware.base import BaseHTTPMiddleware

        from memos.plugins.base import MemOSPlugin

        class NoopMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                return await call_next(request)

        app = FastAPI()

        @app.get("/x")
        async def x():
            return {}

        plugin = MemOSPlugin()
        plugin._bind_app(app)
        plugin.register_middleware(NoopMiddleware)

        client = TestClient(app)
        resp = client.get("/x")
        assert resp.status_code == 200

    def test_register_hook(self):
        from memos.plugins.base import MemOSPlugin
        from memos.plugins.hook_defs import define_hook
        from memos.plugins.hooks import trigger_hook

        define_hook("test.reg.event", description="test", params=["x"])

        called = []
        plugin = MemOSPlugin()
        plugin._bind_app(FastAPI())
        plugin.register_hook("test.reg.event", lambda **kw: called.append(True))

        trigger_hook("test.reg.event", x=1)
        assert called == [True]

    def test_register_hooks_batch(self):
        from memos.plugins.base import MemOSPlugin
        from memos.plugins.hook_defs import define_hook
        from memos.plugins.hooks import trigger_hook

        define_hook("batch.a", description="a", params=["x"])
        define_hook("batch.b", description="b", params=["x"])

        count = 0

        def cb(**kw):
            nonlocal count
            count += 1

        plugin = MemOSPlugin()
        plugin._bind_app(FastAPI())
        plugin.register_hooks(["batch.a", "batch.b"], cb)

        trigger_hook("batch.a", x=1)
        trigger_hook("batch.b", x=2)
        assert count == 2
