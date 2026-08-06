from __future__ import annotations

from typing import Any


def on_dream_execute(
    plugin,
    *,
    mem_cube_id: str,
    user_id: str,
    user_name: str,
    signal_snapshot,
    text_mem,
    scheduler_context,
    **kwargs,
):
    """Single-provider Dream execution hook.

    The scheduler handler always calls this hook. The active Dream plugin decides
    which pipeline implementation to run. After the pipeline finishes, the hook
    resets the signal store so the next accumulation cycle starts fresh.
    """

    results = plugin.pipeline.run(
        mem_cube_id=mem_cube_id,
        user_id=user_id,
        cube_id=mem_cube_id,
        signal_snapshot=signal_snapshot,
        text_mem=text_mem,
    )
    plugin.signal_store.reset(mem_cube_id=mem_cube_id)
    return results


def on_add_signal(plugin, *, request, result, **kwargs) -> None:
    """Built-in Dream signal capture hook.

    The current implementation only extracts enough information to build a scheduler payload.
    If a runtime scheduler handle is not available yet, the signal is still kept
    locally so manual triggering and future auto-trigger logic use the same store.
    """

    mem_cube_id = _extract_mem_cube_id(request=request, result=result)
    if not mem_cube_id:
        return

    memory_ids = _extract_memory_ids(result)
    snapshot = plugin.signal_store.record_add(
        mem_cube_id=mem_cube_id,
        user_id=getattr(request, "user_id", "") or "",
        user_name=getattr(request, "user_name", "") or "",
        session_id=getattr(request, "session_id", "") or "",
        memory_ids=memory_ids,
    )
    if plugin.signal_store.should_trigger(mem_cube_id=mem_cube_id):
        plugin.submit_dream_task(
            mem_cube_id=mem_cube_id,
            user_id=snapshot.user_id,
            user_name=snapshot.user_name,
            signal_snapshot=snapshot,
        )


def _extract_mem_cube_id(*, request, result) -> str:
    writable_cube_ids = getattr(request, "writable_cube_ids", None) or []
    if writable_cube_ids:
        return writable_cube_ids[0]

    data = getattr(result, "data", None) or []
    for item in data:
        if isinstance(item, dict) and item.get("mem_cube_id"):
            return item["mem_cube_id"]
        mem_cube_id = getattr(item, "mem_cube_id", None)
        if mem_cube_id:
            return mem_cube_id
    return ""


def _extract_memory_ids(result) -> list[str]:
    ids: list[str] = []
    data = getattr(result, "data", None) or []
    for item in data:
        candidate: Any = (
            item.get("memory_id") if isinstance(item, dict) else getattr(item, "memory_id", None)
        )
        if candidate:
            ids.append(str(candidate))
    return ids
