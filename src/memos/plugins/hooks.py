"""Hook runtime — registration, triggering, and @hookable decorator."""

from __future__ import annotations

import asyncio
import inspect
import logging

from collections import defaultdict
from functools import wraps
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable


logger = logging.getLogger(__name__)

_hooks: dict[str, list[tuple[Callable, bool]]] = defaultdict(list)


def _accepts_hook_context(callback: Callable) -> bool:
    """Return whether a callback accepts the additive ``hook_context`` keyword."""
    try:
        parameters = inspect.signature(callback).parameters.values()
    except (TypeError, ValueError):
        return False

    return any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        or (
            parameter.name == "hook_context"
            and parameter.kind
            in {
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                inspect.Parameter.KEYWORD_ONLY,
            }
        )
        for parameter in parameters
    )


def _invoke_hook_callback(callback: Callable, accepts_context: bool, kwargs: dict[str, Any]) -> Any:
    """Invoke one callback while preserving legacy exact-signature Hooks.

    ``hook_context`` is additive framework metadata. Older callbacks that use
    an exact keyword-only signature continue to receive the original business
    arguments. Context-aware callbacks and callbacks with ``**kwargs`` receive
    the complete contract.
    """
    if "hook_context" not in kwargs or accepts_context:
        return callback(**kwargs)

    legacy_kwargs = dict(kwargs)
    legacy_kwargs.pop("hook_context")
    return callback(**legacy_kwargs)


def register_hook(name: str, callback: Callable) -> None:
    """Register a hook callback. Undeclared hook names will log a warning."""
    from memos.plugins.hook_defs import get_hook_spec

    if get_hook_spec(name) is None:
        logger.warning(
            "Registering callback for undeclared hook: %s (callback=%s)",
            name,
            getattr(callback, "__qualname__", repr(callback)),
        )
    _hooks[name].append((callback, _accepts_hook_context(callback)))
    logger.debug(
        "Hook registered: %s -> %s",
        name,
        getattr(callback, "__qualname__", repr(callback)),
    )


def register_hooks(names: list[str], callback: Callable) -> None:
    """Batch-register the same callback to multiple hook points."""
    for name in names:
        register_hook(name, callback)


def trigger_hook(name: str, **kwargs: Any) -> Any:
    """Trigger a hook, invoking all registered callbacks in order.

    - No callback inspection when triggering hooks
    - Undeclared hook names will log a warning and be skipped
    - pipe_key is auto-fetched from HookSpec, supports piped return value passing
    """
    from memos.plugins.hook_defs import get_hook_spec

    spec = get_hook_spec(name)
    if spec is None:
        logger.warning("Undeclared hook triggered: %s — ignored", name)
        return None

    pipe_key = spec.pipe_key

    for cb, accepts_context in _hooks.get(name, []):
        try:
            rv = _invoke_hook_callback(cb, accepts_context, kwargs)
            if pipe_key is not None and rv is not None:
                kwargs[pipe_key] = rv
        except Exception:
            logger.exception(
                "Hook %s callback %s failed",
                name,
                getattr(cb, "__qualname__", repr(cb)),
            )

    return kwargs.get(pipe_key) if pipe_key else None


def trigger_single_hook(name: str, **kwargs: Any) -> Any:
    """Trigger a hook that must be implemented by exactly one callback."""
    from memos.plugins.hook_defs import get_hook_spec

    spec = get_hook_spec(name)
    if spec is None:
        raise RuntimeError(f"Undeclared hook triggered: {name}")

    callbacks = _hooks.get(name, [])
    if not callbacks:
        raise RuntimeError(f"No plugin registered required hook: {name}")
    if len(callbacks) > 1:
        raise RuntimeError(f"Multiple plugins registered single-provider hook: {name}")

    cb, accepts_context = callbacks[0]
    try:
        return _invoke_hook_callback(cb, accepts_context, kwargs)
    except Exception:
        logger.exception(
            "Single hook %s callback %s failed",
            name,
            getattr(cb, "__qualname__", repr(cb)),
        )
        raise


def hookable(
    name: str,
    *,
    context_builder: Callable[[Any, Any], Any] | None = None,
):
    """Decorator: automatically triggers name.before / name.after hook before and after the method.

    Auto-declares before/after Hooks (idempotent); no need to manually define_hook in hook_defs.py.
    Supports piped return values: before can modify request, after can modify result.
    When ``context_builder`` is provided, one context is built before the first
    Hook and passed to both Hooks as ``hook_context``. It is also passed to the
    decorated method when that method accepts it.
    Compatible with both sync and async methods.
    """
    from memos.plugins.hook_defs import define_hook

    before_params = ["request"]
    after_params = ["request", "result"]
    if context_builder is not None:
        before_params.insert(0, "hook_context")
        after_params.insert(0, "hook_context")

    define_hook(
        f"{name}.before",
        description=f"Before {name} executes; can modify request",
        params=before_params,
        pipe_key="request",
    )
    define_hook(
        f"{name}.after",
        description=f"After {name} executes; can modify result",
        params=after_params,
        pipe_key="result",
    )

    def decorator(func):
        signature = inspect.signature(func)
        accepts_context = _accepts_hook_context(func)
        context_parameter = signature.parameters.get("hook_context")
        if context_parameter is not None and context_parameter.kind in {
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        }:
            context_parameter = None

        def prepare_call(self, request, args, kwargs):
            hook_context = kwargs.get("hook_context")
            bound = None
            if context_parameter is not None:
                bound = signature.bind_partial(self, request, *args, **kwargs)
                hook_context = bound.arguments.get("hook_context")
            if hook_context is None and context_builder is not None:
                hook_context = context_builder(self, request)

            call_kwargs = dict(kwargs)
            if bound is not None and context_builder is not None:
                bound.arguments["hook_context"] = hook_context
                bound.apply_defaults()
                args, call_kwargs = bound.args[2:], bound.kwargs
            elif not accepts_context:
                call_kwargs.pop("hook_context", None)
            elif context_builder is not None:
                call_kwargs["hook_context"] = hook_context
            return hook_context, args, call_kwargs

        if asyncio.iscoroutinefunction(func):

            @wraps(func)
            async def async_wrapper(self, request, *args, **kwargs):
                hook_context, args, call_kwargs = prepare_call(self, request, args, kwargs)
                before_kwargs = {"request": request}
                if context_builder is not None:
                    before_kwargs["hook_context"] = hook_context

                rv = trigger_hook(f"{name}.before", **before_kwargs)
                request = rv if rv is not None else request
                result = await func(self, request, *args, **call_kwargs)
                after_kwargs = {"request": request, "result": result}
                if context_builder is not None:
                    after_kwargs["hook_context"] = hook_context
                rv = trigger_hook(f"{name}.after", **after_kwargs)
                result = rv if rv is not None else result
                return result

            return async_wrapper

        @wraps(func)
        def sync_wrapper(self, request, *args, **kwargs):
            hook_context, args, call_kwargs = prepare_call(self, request, args, kwargs)
            before_kwargs = {"request": request}
            if context_builder is not None:
                before_kwargs["hook_context"] = hook_context

            rv = trigger_hook(f"{name}.before", **before_kwargs)
            request = rv if rv is not None else request
            result = func(self, request, *args, **call_kwargs)
            after_kwargs = {"request": request, "result": result}
            if context_builder is not None:
                after_kwargs["hook_context"] = hook_context
            rv = trigger_hook(f"{name}.after", **after_kwargs)
            result = rv if rv is not None else result
            return result

        return sync_wrapper

    return decorator
