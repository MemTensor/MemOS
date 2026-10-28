"""Process-scoped bridge ownership and Hermes hook routing.

Hermes creates one memory provider per cached agent/session.  The MemOS Node
bridge, however, owns process-wide resources (MemoryCore, SQLite connections,
model clients, and background workers) that are designed to multiplex logical
``sessionId`` values.  This module keeps exactly one physical bridge per
runtime/data-home key while handing providers lightweight leases.
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import threading
import time
import weakref

from typing import TYPE_CHECKING, Any

from bridge_client import BridgeError, MemosBridgeClient


if TYPE_CHECKING:
    from collections.abc import Callable, Hashable


logger = logging.getLogger(__name__)

_TRANSPORT_ERROR_MARKERS = ("broken pipe", "bridge closed", "transport_closed")


def _is_transport_closed(err: Exception) -> bool:
    if isinstance(err, BridgeError) and err.code == "transport_closed":
        return True
    return any(marker in str(err).lower() for marker in _TRANSPORT_ERROR_MARKERS)


class _CallableRef:
    """Weak reference wrapper that also supports non-weak-referenceable callables."""

    def __init__(self, callback: Callable[..., Any]) -> None:
        self._strong: Callable[..., Any] | None = None
        try:
            if getattr(callback, "__self__", None) is not None:
                self._ref: Callable[[], Callable[..., Any] | None] = weakref.WeakMethod(callback)
            else:
                self._ref = weakref.ref(callback)
        except TypeError:
            self._strong = callback
            self._ref = lambda: self._strong

    def get(self) -> Callable[..., Any] | None:
        return self._ref()


class SharedBridgeRuntime:
    """Own one physical bridge and safely multiplex provider leases."""

    def __init__(
        self,
        key: tuple[Hashable, ...],
        *,
        client_factory: Callable[[], MemosBridgeClient],
        before_spawn: Callable[[], None] | None = None,
        keepalive_interval: float = 10.0,
        keepalive_timeout: float = 10.0,
    ) -> None:
        self.key = key
        self.runtime_id = f"hermes-{abs(hash(key)):x}"
        self._client_factory = client_factory
        self._before_spawn = before_spawn
        self._keepalive_interval = max(0.1, keepalive_interval)
        self._keepalive_timeout = max(0.1, keepalive_timeout)

        self._state_lock = threading.RLock()
        self._reconnect_lock = threading.Lock()
        self._client: MemosBridgeClient | None = None
        self._generation = 0
        self._leases: set[int] = set()
        self._next_lease_id = 1
        self._in_flight = 0
        self._host_handlers: dict[str, dict[int, _CallableRef]] = {}
        self._registered_host_methods: set[str] = set()

        self._failure_count = 0
        self._next_reconnect_at = 0.0
        self._last_reconnect_error: Exception | None = None
        self._keepalive_failures = 0
        self._stop = threading.Event()
        self._keepalive_thread: threading.Thread | None = None

    @property
    def generation(self) -> int:
        with self._state_lock:
            return self._generation

    @property
    def pid(self) -> int:
        with self._state_lock:
            client = self._client
        return int(getattr(client, "pid", 0) or 0) if client is not None else 0

    def acquire(
        self,
        *,
        host_handlers: dict[str, Callable[[dict[str, Any]], Any]] | None = None,
    ) -> SharedBridgeLease:
        with self._state_lock:
            lease_id = self._next_lease_id
            self._next_lease_id += 1
            self._leases.add(lease_id)
            lease = SharedBridgeLease(self, lease_id)
            client = self._client
            newly_registered_methods: list[str] = []
            for method, handler in (host_handlers or {}).items():
                self._host_handlers.setdefault(method, {})[lease_id] = _CallableRef(handler)
                if method not in self._registered_host_methods:
                    self._registered_host_methods.add(method)
                    newly_registered_methods.append(method)
            allow_backoff = self._generation > 0 or self._failure_count > 0
            should_start_keepalive = (
                self._keepalive_thread is None or not self._keepalive_thread.is_alive()
            )
        # Existing clients need newly introduced reverse handlers immediately.
        # New clients install all known dispatchers before their first health
        # request, preventing startup-time host RPC from blocking the reader.
        try:
            if client is not None:
                for method in newly_registered_methods:
                    client.register_host_handler(method, self._host_dispatcher(method))
            self.ensure_client(allow_backoff=allow_backoff)
        except Exception:
            self.release(lease_id)
            with self._state_lock:
                for method in newly_registered_methods:
                    if not self._host_handlers.get(method):
                        self._registered_host_methods.discard(method)
            raise
        if should_start_keepalive:
            self._start_keepalive()
        logger.debug(
            "MemOS: acquired shared bridge lease runtime=%s generation=%d pid=%s leases=%d",
            self.runtime_id,
            self.generation,
            self.pid,
            self.lease_count,
        )
        return lease

    @property
    def lease_count(self) -> int:
        with self._state_lock:
            return len(self._leases)

    def ensure_client(self, *, allow_backoff: bool = True) -> None:
        with self._state_lock:
            if self._client is not None:
                return
            generation = self._generation
        self.reconnect(expected_generation=generation, allow_backoff=allow_backoff)

    def request(
        self,
        lease_id: int,
        method: str,
        params: Any = None,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        with self._state_lock:
            if lease_id not in self._leases:
                raise BridgeError("transport_closed", "shared bridge lease is closed")
            client = self._client
            self._in_flight += 1
        try:
            if client is None:
                self.ensure_client(allow_backoff=True)
                with self._state_lock:
                    client = self._client
            if client is None:  # pragma: no cover - defensive after ensure_client
                raise BridgeError("transport_closed", "shared bridge is unavailable")
            return client.request(method, params, timeout=timeout)
        finally:
            with self._state_lock:
                self._in_flight = max(0, self._in_flight - 1)

    def reconnect(
        self,
        *,
        expected_generation: int | None = None,
        allow_backoff: bool = True,
    ) -> int:
        """Replace the bridge once; stale concurrent reconnects reuse the winner."""
        with self._reconnect_lock:
            with self._state_lock:
                if (
                    expected_generation is not None
                    and self._client is not None
                    and self._generation != expected_generation
                ):
                    return self._generation
                if allow_backoff and time.monotonic() < self._next_reconnect_at:
                    err = self._last_reconnect_error
                    message = "shared bridge reconnect is backing off"
                    if err is not None:
                        message = f"{message}: {err}"
                    raise BridgeError("transport_closed", message)
                old_client = self._client
                old_pid = int(getattr(old_client, "pid", 0) or 0) if old_client else 0
                self._client = None

            if old_client is not None:
                with contextlib.suppress(Exception):
                    old_client.close()

            new_client: MemosBridgeClient | None = None
            try:
                if self._before_spawn is not None:
                    self._before_spawn()
                new_client = self._client_factory()
                self._install_host_dispatchers(new_client)
                new_client.request("core.health", {}, timeout=self._keepalive_timeout)
            except Exception as err:
                if new_client is not None:
                    with contextlib.suppress(Exception):
                        new_client.close()
                self._record_reconnect_failure(err)
                raise

            with self._state_lock:
                self._client = new_client
                self._generation += 1
                self._failure_count = 0
                self._next_reconnect_at = 0.0
                self._last_reconnect_error = None
                self._keepalive_failures = 0
                generation = self._generation
                lease_count = len(self._leases)
            logger.info(
                "MemOS: shared bridge ready runtime=%s generation=%d pid=%s old_pid=%s leases=%d",
                self.runtime_id,
                generation,
                self.pid,
                old_pid or "-",
                lease_count,
            )
            return generation

    def register_host_handler(
        self,
        lease_id: int,
        method: str,
        handler: Callable[[dict[str, Any]], Any],
    ) -> None:
        with self._state_lock:
            if lease_id not in self._leases:
                return
            handlers = self._host_handlers.setdefault(method, {})
            handlers[lease_id] = _CallableRef(handler)
            client = self._client
            needs_registration = method not in self._registered_host_methods
            if needs_registration:
                self._registered_host_methods.add(method)
        if needs_registration and client is not None:
            client.register_host_handler(method, self._host_dispatcher(method))

    def release(self, lease_id: int) -> None:
        with self._state_lock:
            self._leases.discard(lease_id)
            for handlers in self._host_handlers.values():
                handlers.pop(lease_id, None)
            leases = len(self._leases)
        logger.debug(
            "MemOS: released shared bridge lease runtime=%s generation=%d pid=%s leases=%d",
            self.runtime_id,
            self.generation,
            self.pid,
            leases,
        )

    def status(self) -> dict[str, Any]:
        with self._state_lock:
            return {
                "runtimeId": self.runtime_id,
                "generation": self._generation,
                "pid": self.pid,
                "leases": len(self._leases),
                "inFlight": self._in_flight,
                "reconnectFailures": self._failure_count,
                "keepaliveFailures": self._keepalive_failures,
            }

    def close(self) -> None:
        self._stop.set()
        thread = self._keepalive_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=min(self._keepalive_timeout + 1.0, 12.0))
        with self._state_lock:
            client = self._client
            self._client = None
            self._leases.clear()
            self._host_handlers.clear()
        if client is not None:
            with contextlib.suppress(Exception):
                client.close()

    def _record_reconnect_failure(self, err: Exception) -> None:
        with self._state_lock:
            self._failure_count += 1
            delay = min(30.0, float(2 ** min(self._failure_count - 1, 5)))
            self._next_reconnect_at = time.monotonic() + delay
            self._last_reconnect_error = err
            failure_count = self._failure_count
        logger.warning(
            "MemOS: shared bridge reconnect failed runtime=%s failures=%d retry_in=%.1fs — %s",
            self.runtime_id,
            failure_count,
            delay,
            err,
        )

    def _host_dispatcher(self, method: str) -> Callable[[dict[str, Any]], Any]:
        def dispatch(params: dict[str, Any]) -> Any:
            with self._state_lock:
                handlers = self._host_handlers.get(method, {})
                candidates = list(reversed(handlers.items()))
            stale: list[int] = []
            for lease_id, callback_ref in candidates:
                callback = callback_ref.get()
                if callback is not None:
                    return callback(params)
                stale.append(lease_id)
            if stale:
                with self._state_lock:
                    current = self._host_handlers.get(method, {})
                    for lease_id in stale:
                        current.pop(lease_id, None)
            raise BridgeError("host_unavailable", f"no active host handler for {method}")

        return dispatch

    def _install_host_dispatchers(self, client: MemosBridgeClient) -> None:
        with self._state_lock:
            methods = list(self._registered_host_methods)
        for method in methods:
            client.register_host_handler(method, self._host_dispatcher(method))

    def _start_keepalive(self) -> None:
        with self._state_lock:
            if self._keepalive_thread is not None and self._keepalive_thread.is_alive():
                return
            self._stop.clear()
            thread = threading.Thread(
                target=self._keepalive_loop,
                daemon=True,
                name=f"memos-shared-bridge-keepalive-{self.runtime_id}",
            )
            self._keepalive_thread = thread
        thread.start()

    def _keepalive_loop(self) -> None:
        while not self._stop.wait(self._keepalive_interval):
            with self._state_lock:
                client = self._client
                generation = self._generation
                in_flight = self._in_flight
            # A capture/retrieval call may legitimately spend up to the
            # provider's long-RPC timeout in an embedding or LLM request.
            # Do not let a concurrent health timeout kill healthy in-flight
            # work for every session.
            if in_flight:
                continue
            if client is None:
                with contextlib.suppress(Exception):
                    self.reconnect(expected_generation=generation)
                continue
            try:
                client.request("core.health", {}, timeout=self._keepalive_timeout)
                with self._state_lock:
                    self._keepalive_failures = 0
            except Exception as err:
                with self._state_lock:
                    self._keepalive_failures += 1
                    failures = self._keepalive_failures
                should_reconnect = _is_transport_closed(err) or (
                    isinstance(err, BridgeError) and err.code == "timeout" and failures >= 2
                )
                if not should_reconnect:
                    logger.debug(
                        "MemOS: shared bridge keepalive failed runtime=%s failures=%d — %s",
                        self.runtime_id,
                        failures,
                        err,
                    )
                    continue
                logger.warning(
                    "MemOS: shared bridge keepalive reconnecting runtime=%s "
                    "generation=%d failures=%d — %s",
                    self.runtime_id,
                    generation,
                    failures,
                    err,
                )
                with contextlib.suppress(Exception):
                    self.reconnect(expected_generation=generation)


class SharedBridgeLease:
    """Provider-facing handle that never owns or closes the physical bridge."""

    def __init__(self, runtime: SharedBridgeRuntime, lease_id: int) -> None:
        self._runtime = runtime
        self._lease_id = lease_id
        self._closed = False

    @property
    def pid(self) -> int:
        return self._runtime.pid

    @property
    def generation(self) -> int:
        return self._runtime.generation

    @property
    def runtime_id(self) -> str:
        return self._runtime.runtime_id

    def request(
        self,
        method: str,
        params: Any = None,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        if self._closed:
            raise BridgeError("transport_closed", "shared bridge lease is closed")
        return self._runtime.request(self._lease_id, method, params, timeout=timeout)

    def reconnect(self, *, expected_generation: int | None = None) -> int:
        if self._closed:
            raise BridgeError("transport_closed", "shared bridge lease is closed")
        return self._runtime.reconnect(expected_generation=expected_generation)

    def register_host_handler(
        self,
        method: str,
        handler: Callable[[dict[str, Any]], Any],
    ) -> None:
        self._runtime.register_host_handler(self._lease_id, method, handler)

    def status(self) -> dict[str, Any]:
        return self._runtime.status()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._runtime.release(self._lease_id)


class SharedBridgeRuntimeRegistry:
    """Registry of shared runtimes, isolated by resolved MemOS data home."""

    def __init__(
        self,
        *,
        keepalive_interval: float = 10.0,
        keepalive_timeout: float = 10.0,
    ) -> None:
        self._lock = threading.Lock()
        self._runtimes: dict[tuple[Hashable, ...], SharedBridgeRuntime] = {}
        self._keepalive_interval = keepalive_interval
        self._keepalive_timeout = keepalive_timeout

    def acquire(
        self,
        key: tuple[Hashable, ...],
        *,
        client_factory: Callable[[], MemosBridgeClient],
        before_spawn: Callable[[], None] | None = None,
        host_handlers: dict[str, Callable[[dict[str, Any]], Any]] | None = None,
    ) -> SharedBridgeLease:
        with self._lock:
            runtime = self._runtimes.get(key)
            if runtime is None:
                runtime = SharedBridgeRuntime(
                    key,
                    client_factory=client_factory,
                    before_spawn=before_spawn,
                    keepalive_interval=self._keepalive_interval,
                    keepalive_timeout=self._keepalive_timeout,
                )
                self._runtimes[key] = runtime
        # Keep a failed runtime entry so its exponential backoff applies to
        # later providers. Removing it here would let each new Hermes session
        # create a fresh runtime and bypass the circuit breaker.
        return runtime.acquire(host_handlers=host_handlers)

    def close_all(self) -> None:
        with self._lock:
            runtimes = list(self._runtimes.values())
            self._runtimes.clear()
        for runtime in runtimes:
            runtime.close()

    def status(self) -> list[dict[str, Any]]:
        with self._lock:
            runtimes = list(self._runtimes.values())
        return [runtime.status() for runtime in runtimes]


class HermesHookDispatcher:
    """Register one global Hermes hook set and route events by session."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._providers: dict[int, weakref.ReferenceType[Any]] = {}
        self._registered_managers: set[int] = set()
        self._last_ambiguous_warning = 0.0

    def bind(self, manager: Any, provider: Any) -> None:
        with self._lock:
            self._providers[id(provider)] = weakref.ref(provider)
            manager_id = id(manager)
            if manager_id in self._registered_managers:
                return
            manager._hooks.setdefault("post_tool_call", []).append(self._post_tool_call)
            manager._hooks.setdefault("post_llm_call", []).append(self._post_llm_call)
            manager._hooks.setdefault("transform_tool_result", []).append(
                self._transform_tool_result
            )
            self._registered_managers.add(manager_id)
        logger.debug("MemOS: registered one shared Hermes hook dispatcher")

    def unbind(self, provider: Any) -> None:
        with self._lock:
            self._providers.pop(id(provider), None)

    def _live_providers(self) -> list[Any]:
        with self._lock:
            items = list(self._providers.items())
        live: list[Any] = []
        stale: list[int] = []
        for provider_id, provider_ref in items:
            provider = provider_ref()
            if provider is None:
                stale.append(provider_id)
            else:
                live.append(provider)
        if stale:
            with self._lock:
                for provider_id in stale:
                    self._providers.pop(provider_id, None)
        return live

    def _select(self, kwargs: dict[str, Any]) -> Any | None:
        session_id = str(kwargs.get("session_id") or kwargs.get("sessionId") or "")
        providers = self._live_providers()
        if session_id:
            matches = [p for p in providers if str(getattr(p, "_session_id", "")) == session_id]
            return matches[-1] if matches else None
        if len(providers) == 1:
            return providers[0]
        if len(providers) > 1:
            now = time.monotonic()
            with self._lock:
                if now - self._last_ambiguous_warning >= 60.0:
                    self._last_ambiguous_warning = now
                    logger.warning(
                        "MemOS: ignored sessionless Hermes hook with %d active providers; "
                        "event was not broadcast",
                        len(providers),
                    )
        return None

    def _post_tool_call(self, **kwargs: Any) -> None:
        provider = self._select(kwargs)
        if provider is not None:
            provider._on_post_tool_call(**kwargs)

    def _post_llm_call(self, **kwargs: Any) -> None:
        provider = self._select(kwargs)
        if provider is not None:
            provider._on_post_llm_call(**kwargs)

    def _transform_tool_result(self, **kwargs: Any) -> str | None:
        provider = self._select(kwargs)
        if provider is None:
            return None
        return provider._on_transform_tool_result(**kwargs)


SHARED_BRIDGE_REGISTRY = SharedBridgeRuntimeRegistry()
HERMES_HOOK_DISPATCHER = HermesHookDispatcher()
atexit.register(SHARED_BRIDGE_REGISTRY.close_all)


__all__ = [
    "HERMES_HOOK_DISPATCHER",
    "SHARED_BRIDGE_REGISTRY",
    "HermesHookDispatcher",
    "SharedBridgeLease",
    "SharedBridgeRuntime",
    "SharedBridgeRuntimeRegistry",
]
