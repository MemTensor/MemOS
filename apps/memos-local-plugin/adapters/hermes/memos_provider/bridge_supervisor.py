"""Process-wide supervision of the MemOS stdio bridge (issue #1910).

Why this module exists
----------------------
The Hermes host gives no guarantee about provider lifecycles: it builds a
fresh ``MemTensorProvider`` on every ``load_memory_provider()`` call, and
older hosts forked review/delegate agents that rebuilt the provider per
turn and abandoned it without ever calling ``shutdown()``. When each
provider instance owned its own Node bridge subprocess, every abandoned
instance leaked one live ``bridge.cjs`` process — and its private
keepalive thread resurrected the process even after a manual ``kill``.

The invariant enforced here: **at most one live bridge client per host
process**, regardless of how many provider instances exist. Ownership is
moved off the provider instances onto a module-level supervisor:

* ``BridgeSupervisor`` — refcounted (via ``WeakSet`` of holders) shared
  client with generation-aware replacement, plus a single keepalive
  thread that respawns the *shared* client after a crash and stops once
  the last holder releases.
* a weakref provider registry + once-per-process host hook installation,
  so N provider instances no longer append N copies of bound-method
  hooks to the host's global plugin manager (which both duplicated hook
  work and pinned abandoned instances forever).

The bridge JSON-RPC protocol is multi-session (``session.open`` carries
``sessionId``), so sharing one client across providers is semantically
free — the ``--daemon`` viewer process already shares a core the same way.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import weakref

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable


logger = logging.getLogger(__name__)

KEEPALIVE_INTERVAL_SEC = 5.0
KEEPALIVE_PING_TIMEOUT_SEC = 10.0


def transport_closed(err: Exception) -> bool:
    """Classify an exception as "the bridge pipe is gone"."""
    if getattr(err, "code", "") == "transport_closed":
        return True
    msg = str(err).lower()
    return "broken pipe" in msg or "bridge closed" in msg or "transport_closed" in msg


class BridgeSupervisor:
    """Owns the single shared bridge client for this host process.

    Holders are provider instances tracked in a ``WeakSet`` — an
    abandoned provider that gets garbage-collected silently drops its
    hold, so a leaky host can no longer keep the refcount pinned.
    The client is closed when the last holder releases; the host
    process exiting closes the child's stdin either way, which the
    bridge treats as a graceful shutdown signal.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._client: Any = None
        self._holders: weakref.WeakSet[Any] = weakref.WeakSet()
        self._factory: Callable[[], Any] | None = None
        self._keepalive_stop = threading.Event()
        self._keepalive_thread: threading.Thread | None = None

    # ─── Client lifecycle ──────────────────────────────────────────────

    def peek(self) -> Any:
        """Return the current shared client (or None) without side effects."""
        with self._lock:
            return self._client

    def acquire(self, holder: Any, factory: Callable[[], Any]) -> tuple[Any, bool]:
        """Register ``holder`` and return ``(client, created)``.

        Reuses the existing shared client when one is live; otherwise
        creates it via ``factory``. Idempotent per holder.
        """
        with self._lock:
            self._factory = factory
            created = False
            if self._client is None:
                self._client = factory()
                created = True
                logger.info(
                    "MemOS: shared bridge client started (pid=%s)",
                    getattr(self._client, "pid", "?"),
                )
            self._holders.add(holder)
            self._ensure_keepalive_locked()
            return self._client, created

    def replace(self, holder: Any, stale: Any, factory: Callable[[], Any]) -> tuple[Any, bool]:
        """Replace the shared client iff ``stale`` is still the current one.

        If another caller already replaced it, adopt the newer client
        instead of spawning a third. Returns ``(client, created)``.
        ``stale`` is always closed (idempotent) once it is no longer the
        shared client.
        """
        to_close: Any = None
        with self._lock:
            self._factory = factory
            current = self._client
            if current is not None and current is not stale:
                client, created = current, False
                to_close = stale
            else:
                self._client = None
                client = factory()
                self._client = client
                created = True
                to_close = current if current is not None else stale
                logger.info(
                    "MemOS: shared bridge client replaced (old pid=%s, new pid=%s)",
                    getattr(to_close, "pid", "?") if to_close is not None else "-",
                    getattr(client, "pid", "?"),
                )
            self._holders.add(holder)
            self._ensure_keepalive_locked()
        if to_close is not None and to_close is not client:
            self._close_quietly(to_close)
        return client, created

    def release(self, holder: Any) -> None:
        """Drop ``holder``; close the shared client when no holders remain."""
        to_close: Any = None
        with self._lock:
            self._holders.discard(holder)
            if len(self._holders) == 0:
                to_close = self._client
                self._client = None
                self._stop_keepalive_locked()
        if to_close is not None:
            logger.info(
                "MemOS: last holder released — closing shared bridge (pid=%s)",
                getattr(to_close, "pid", "?"),
            )
            self._close_quietly(to_close)

    def discard(self, holder: Any, client: Any) -> None:
        """Failure path: drop ``holder`` and close ``client`` it created."""
        with self._lock:
            self._holders.discard(holder)
            if self._client is client:
                self._client = None
            if len(self._holders) == 0:
                self._stop_keepalive_locked()
        if client is not None:
            self._close_quietly(client)

    def respawn(self, stale: Any) -> Any:
        """Keepalive path: replace a dead shared client, holders unchanged.

        Returns the replacement (or the already-newer current client),
        or None when no factory is known, no holders remain, or the
        spawn failed.
        """
        to_close: Any = None
        with self._lock:
            factory = self._factory
            if factory is None:
                return None
            # Hard invariant: zero holders ⇒ no live client. Without this
            # guard, a respawn racing the last release() (the health ping
            # can be mid-flight for up to its timeout) would revive a
            # client that no holder will ever close — the exact leak
            # class this module exists to eliminate.
            if len(self._holders) == 0:
                return None
            current = self._client
            if current is not None and current is not stale:
                return current
            self._client = None
            try:
                client = factory()
            except Exception as err:
                logger.warning("MemOS: bridge respawn failed — %s", err)
                return None
            self._client = client
            to_close = current if current is not None else stale
            logger.info(
                "MemOS: keepalive respawned shared bridge (old pid=%s, new pid=%s)",
                getattr(to_close, "pid", "?") if to_close is not None else "-",
                getattr(client, "pid", "?"),
            )
        if to_close is not None:
            self._close_quietly(to_close)
        return client

    @staticmethod
    def _close_quietly(client: Any) -> None:
        with contextlib.suppress(Exception):
            client.close()

    # ─── Keepalive (one thread per process, not per provider) ─────────

    def _ensure_keepalive_locked(self) -> None:
        if self._keepalive_thread is not None and self._keepalive_thread.is_alive():
            return
        self._keepalive_stop = threading.Event()
        self._keepalive_thread = threading.Thread(
            target=self._keepalive_loop,
            args=(self._keepalive_stop,),
            daemon=True,
            name="memos-bridge-keepalive",
        )
        self._keepalive_thread.start()

    def _stop_keepalive_locked(self) -> None:
        self._keepalive_stop.set()
        # Drop the reference so the next _ensure spawns a fresh thread
        # (with a fresh stop event) even while the old one is still on
        # its way out — checking is_alive() alone races with a rapid
        # release()→acquire() and would leave the new holder without
        # any keepalive. The old thread exits on its own captured event.
        self._keepalive_thread = None

    def _keepalive_loop(self, stop: threading.Event) -> None:
        respawn_failures = 0
        backoff_cycles = 0
        while not stop.wait(KEEPALIVE_INTERVAL_SEC):
            client = self.peek()
            if client is None:
                # A failed reconnect can discard the shared client while
                # holders remain (e.g. session.open timed out on a fresh
                # spawn). Recreate proactively so recovery doesn't have
                # to wait for the next turn's reactive reconnect.
                with self._lock:
                    idle = len(self._holders) == 0
                if idle:
                    respawn_failures = 0
                    backoff_cycles = 0
                    continue
                # Exponential backoff when the factory keeps failing
                # (e.g. Node uninstalled) so a permanently-broken
                # environment doesn't warn every interval forever.
                if backoff_cycles > 0:
                    backoff_cycles -= 1
                    continue
                logger.log(
                    logging.INFO if respawn_failures == 0 else logging.DEBUG,
                    "MemOS: shared bridge missing with live holders; respawning",
                )
                replacement = self.respawn(None)
                if replacement is None:
                    respawn_failures += 1
                    backoff_cycles = min(2**respawn_failures, 12) - 1
                    continue
            else:
                try:
                    client.request("core.health", {}, timeout=KEEPALIVE_PING_TIMEOUT_SEC)
                    respawn_failures = 0
                    backoff_cycles = 0
                    continue
                except Exception as err:
                    if not transport_closed(err):
                        logger.debug("MemOS: bridge keepalive ping failed — %s", err)
                        continue
                logger.info("MemOS: shared bridge transport closed; respawning")
                replacement = self.respawn(client)
                if replacement is None:
                    continue
            respawn_failures = 0
            backoff_cycles = 0
            # Re-register host handlers eagerly so reverse RPC
            # (host.llm.complete) works during the replacement's startup
            # recovery; providers re-open their sessions lazily via
            # `_ensure_bridge` on next use.
            for provider in live_providers():
                with contextlib.suppress(Exception):
                    provider._bind_host_handlers(replacement)


supervisor = BridgeSupervisor()


# ─── Provider registry + once-per-process host hook installation ─────────

_registry_lock = threading.Lock()
_provider_refs: list[weakref.ref[Any]] = []
_hooks_installed = False
_hooked_manager_ref: weakref.ref[Any] | None = None

_HOOK_NAMES = ("post_tool_call", "post_llm_call", "transform_tool_result")


def register_provider(provider: Any) -> None:
    """Track a live provider (weakly) for hook dispatch + handler rebinds."""
    with _registry_lock:
        _prune_locked()
        if not any(ref() is provider for ref in _provider_refs):
            _provider_refs.append(weakref.ref(provider))


def unregister_provider(provider: Any) -> None:
    with _registry_lock:
        _provider_refs[:] = [
            ref for ref in _provider_refs if ref() is not None and ref() is not provider
        ]


def live_providers() -> list[Any]:
    with _registry_lock:
        _prune_locked()
        return [p for p in (ref() for ref in _provider_refs) if p is not None]


def _prune_locked() -> None:
    _provider_refs[:] = [ref for ref in _provider_refs if ref() is not None]


def install_host_hooks() -> bool:
    """Ensure our dispatchers sit in the hermes plugin manager exactly once.

    The previous design appended three bound methods *per provider
    instance* and never removed them — every abandoned instance stayed
    strongly referenced by the host forever. Dispatchers are module-level
    functions; provider instances are reached weakly via the registry.

    Installation is idempotent *and self-healing*: instead of a boolean
    short-circuit, each call verifies the dispatchers are actually
    present in the *current* manager's hook lists — hosts can rebuild
    the plugin manager or clear its ``_hooks`` on plugin reload, which
    would otherwise leave us silently unhooked.
    """
    global _hooks_installed, _hooked_manager_ref
    with _registry_lock:
        try:
            from hermes_cli.plugins import (
                get_plugin_manager,  # pyright: ignore[reportMissingImports]
            )

            mgr = get_plugin_manager()
            hooks = mgr._hooks
            installed_any = False
            for name, dispatcher in (
                ("post_tool_call", _dispatch_post_tool_call),
                ("post_llm_call", _dispatch_post_llm_call),
                ("transform_tool_result", _dispatch_transform_tool_result),
            ):
                callbacks = hooks.setdefault(name, [])
                if dispatcher not in callbacks:
                    callbacks.append(dispatcher)
                    installed_any = True
            _hooks_installed = True
            _hooked_manager_ref = weakref.ref(mgr)
            if installed_any:
                logger.debug(
                    "MemOS: installed post_tool_call + post_llm_call + "
                    "transform_tool_result dispatchers (process-wide, once)"
                )
            return True
        except Exception as err:
            logger.debug("MemOS: could not install host hooks — %s", err)
            return False


def _dispatch_post_tool_call(*args: Any, **kwargs: Any) -> None:
    for provider in live_providers():
        try:
            provider._on_post_tool_call(*args, **kwargs)
        except Exception:
            logger.debug("MemOS: post_tool_call dispatch failed", exc_info=True)


def _dispatch_post_llm_call(*args: Any, **kwargs: Any) -> None:
    for provider in live_providers():
        try:
            provider._on_post_llm_call(*args, **kwargs)
        except Exception:
            logger.debug("MemOS: post_llm_call dispatch failed", exc_info=True)


def _dispatch_transform_tool_result(*args: Any, **kwargs: Any) -> str | None:
    """First non-None transform wins.

    Deliberate convergence from the old per-instance chain: providers for
    other sessions return None via their ``_matches_session`` guard, and
    the only non-None transform (the repeated-failure repair hint) is
    identical and de-duplicated across providers, so first-wins matches
    the old chain's net effect without N copies of the hook.
    """
    for provider in live_providers():
        try:
            result = provider._on_transform_tool_result(*args, **kwargs)
        except Exception:
            logger.debug("MemOS: transform_tool_result dispatch failed", exc_info=True)
            continue
        if result is not None:
            return result
    return None


# ─── Test support ─────────────────────────────────────────────────────────


def reset_for_tests() -> None:
    """Tear down all process-wide state. Test-only."""
    global _hooks_installed, _hooked_manager_ref
    with supervisor._lock:
        client = supervisor._client
        # Capture before _stop_keepalive_locked clears the reference,
        # or the join below would silently never run.
        thread = supervisor._keepalive_thread
        supervisor._client = None
        supervisor._factory = None
        supervisor._holders = weakref.WeakSet()
        supervisor._stop_keepalive_locked()
    if client is not None:
        with contextlib.suppress(Exception):
            client.close()
    if thread is not None and thread.is_alive():
        thread.join(timeout=2.0)
    with _registry_lock:
        _provider_refs.clear()
        mgr = _hooked_manager_ref() if _hooked_manager_ref is not None else None
        if mgr is not None:
            hooks = getattr(mgr, "_hooks", {})
            for name in _HOOK_NAMES:
                callbacks = hooks.get(name)
                if isinstance(callbacks, list):
                    hooks[name] = [
                        cb
                        for cb in callbacks
                        if cb
                        not in (
                            _dispatch_post_tool_call,
                            _dispatch_post_llm_call,
                            _dispatch_transform_tool_result,
                        )
                    ]
        _hooks_installed = False
        _hooked_manager_ref = None
