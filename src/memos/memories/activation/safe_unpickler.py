"""Shared restricted-unpickler infrastructure for activation caches.

Issue #2203: raw ``pickle.load`` on an activation-cache file is a CWE-502
sink. Both :mod:`memos.memories.activation.kv` and
:mod:`memos.memories.activation.vllmkv` need a restricted unpickler that
enforces a per-cache allowlist at ``find_class`` time (before any reduce
callable runs).

To avoid drift between the two caches, the common allowlist and the base
``_SafeUnpickler`` class live here. Each cache module extends the base
allowlist with its own extra entries and passes the merged set to a
subclass of :class:`_BaseSafeUnpickler`.
"""

from __future__ import annotations

import pickle


# Classes that both KV and vLLM caches always need: the ``dict`` wrapper
# around ``kv_cache_memories``, common stdlib containers, and
# ``datetime.*`` for metadata timestamps.
_BASE_ALLOWED_CLASSES: frozenset[tuple[str, str]] = frozenset(
    {
        ("builtins", "dict"),
        ("builtins", "list"),
        ("builtins", "tuple"),
        ("builtins", "set"),
        ("builtins", "frozenset"),
        ("builtins", "str"),
        ("builtins", "int"),
        ("builtins", "float"),
        ("builtins", "bool"),
        ("builtins", "bytes"),
        ("collections", "OrderedDict"),
        ("datetime", "datetime"),
        ("datetime", "date"),
        ("datetime", "time"),
        ("datetime", "timedelta"),
        ("datetime", "timezone"),
    }
)


class _BaseSafeUnpickler(pickle.Unpickler):
    """Restricted :class:`pickle.Unpickler` with a class-attribute allowlist.

    Subclasses must define ``_allowed_classes: frozenset[tuple[str, str]]``.
    Any class outside the allowlist is rejected at ``find_class`` time,
    before the class is imported and before any reduce callable is
    invoked. This blocks the CWE-502 sink documented in issue #2203.
    """

    _allowed_classes: frozenset[tuple[str, str]] = frozenset()

    def find_class(self, module: str, name: str):  # type: ignore[override]
        if (module, name) not in self._allowed_classes:
            raise pickle.UnpicklingError(
                f"Refusing to load class {module}.{name} from activation cache"
            )
        return super().find_class(module, name)
