"""Hook runtime — registration, triggering, and @hookable decorator."""

from __future__ import annotations

import asyncio
import logging

from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from typing import TYPE_CHECKING, Any
from uuid import uuid4


if TYPE_CHECKING:
    from collections.abc import Callable


logger = logging.getLogger(__name__)

_hooks: dict[str, list[Callable]] = defaultdict(list)


def register_hook(name: str, callback: Callable) -> None:
    """Register a hook callback. Undeclared hook names will log a warning."""
    from memos.plugins.hook_defs import get_hook_spec

    if get_hook_spec(name) is None:
        logger.warning(
            "Registering callback for undeclared hook: %s (callback=%s)",
            name,
            getattr(callback, "__qualname__", repr(callback)),
        )
    _hooks[name].append(callback)
    logger.debug(
        "Hook registered: %s -> %s",
        name,
        getattr(callback, "__qualname__", repr(callback)),
    )


def unregister_hook(name: str, callback: Callable) -> None:
    """Remove one owned registration, retaining other plugins' callbacks."""
    callbacks = _hooks.get(name, [])
    for index, registered in enumerate(callbacks):
        if registered is callback:
            del callbacks[index]
            break
    if not callbacks:
        _hooks.pop(name, None)


@dataclass(frozen=True)
class HookDelivery:
    """Synchronous notification delivery outcomes, separate from business success."""

    attempted: int = 0
    failed: int = 0


def notify_hook(name: str, **kwargs: Any) -> HookDelivery:
    """Notify observers with separate detached snapshots and ignore return values.

    Unlike pipes, notifications cannot mutate the returned payload or another
    observer's view. Delivery failures are logged/counted, not transactionally
    coupled to a preceding successful operation. No snapshot is made when idle.
    """
    from memos.plugins.hook_defs import get_hook_spec

    spec = get_hook_spec(name)
    if spec is None or spec.pipe_key is not None:
        raise ValueError("Notifications require a declared non-pipe hook")
    callbacks = tuple(_hooks.get(name, ()))
    failed = 0
    for callback in callbacks:
        try:
            callback(**deepcopy(kwargs))
        except Exception:
            failed += 1
            logger.exception("Notification %s callback failed", name)
    return HookDelivery(len(callbacks), failed)


def register_hooks(names: list[str], callback: Callable) -> None:
    """Batch-register the same callback to multiple hook points."""
    for name in names:
        register_hook(name, callback)


def trigger_hook(name: str, **kwargs: Any) -> Any:
    """Trigger a hook, invoking all registered callbacks in order.

    - Zero overhead when no callbacks are registered
    - Undeclared hook names will log a warning and be skipped
    - pipe_key is auto-fetched from HookSpec, supports piped return value passing
    """
    from memos.plugins.hook_defs import get_hook_spec

    spec = get_hook_spec(name)
    if spec is None:
        logger.warning("Undeclared hook triggered: %s — ignored", name)
        return None

    pipe_key = spec.pipe_key

    for cb in _hooks.get(name, []):
        try:
            rv = cb(**kwargs)
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

    cb = callbacks[0]
    try:
        return cb(**kwargs)
    except Exception:
        logger.exception(
            "Single hook %s callback %s failed",
            name,
            getattr(cb, "__qualname__", repr(cb)),
        )
        raise


def hookable(name: str):
    """Decorator: automatically triggers name.before / name.after hook before and after the method.

    Auto-declares before/after Hooks (idempotent); no need to manually define_hook in hook_defs.py.
    Supports piped return values: before can modify request, after can modify result.
    Compatible with both sync and async methods.
    """
    from memos.plugins.hook_defs import define_hook

    define_hook(
        f"{name}.before",
        description=f"Before {name} executes; can modify request",
        params=["request"],
        pipe_key="request",
    )
    define_hook(
        f"{name}.after",
        description=f"After {name} executes; can modify result",
        params=["request", "result"],
        pipe_key="result",
    )

    define_hook(
        f"{name}.completed",
        description=f"Observe the final {name} result after every result pipe",
        params=["request", "result", "event_id", "at"],
    )

    def decorator(func):
        if asyncio.iscoroutinefunction(func):

            @wraps(func)
            async def async_wrapper(self, request, *args, **kwargs):
                rv = trigger_hook(f"{name}.before", request=request)
                request = rv if rv is not None else request
                result = await func(self, request, *args, **kwargs)
                rv = trigger_hook(f"{name}.after", request=request, result=result)
                result = rv if rv is not None else result
                if _hooks.get(f"{name}.completed"):
                    notify_hook(
                        f"{name}.completed",
                        request=request,
                        result=result,
                        event_id=f"{name}:" + uuid4().hex,
                        at=datetime.now(timezone.utc),
                    )
                return result

            return async_wrapper

        @wraps(func)
        def sync_wrapper(self, request, *args, **kwargs):
            rv = trigger_hook(f"{name}.before", request=request)
            request = rv if rv is not None else request
            result = func(self, request, *args, **kwargs)
            rv = trigger_hook(f"{name}.after", request=request, result=result)
            result = rv if rv is not None else result
            if _hooks.get(f"{name}.completed"):
                notify_hook(
                    f"{name}.completed",
                    request=request,
                    result=result,
                    event_id=f"{name}:" + uuid4().hex,
                    at=datetime.now(timezone.utc),
                )
            return result

        return sync_wrapper

    return decorator
