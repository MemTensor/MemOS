from __future__ import annotations


def resolve_cube_ids(
    cube_ids: list[str] | None,
    fallback_user_id: str,
) -> list[str]:
    """
    Normalize cube ids for API handlers.

    Empty or duplicate entries are removed. If no cube ids are provided, the
    request falls back to the caller's user id for backward compatibility.
    """
    if cube_ids:
        normalized = list(dict.fromkeys(cube_id for cube_id in cube_ids if cube_id))
        if normalized:
            return normalized

    return [fallback_user_id]
