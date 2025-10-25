from typing import Any

from memos.templates.prefer_complete_prompt import PREF_INSTRUCTIONS


def instruct_completion(
    memories: list[dict[str, Any]] | None = None,
) -> str:
    """Create instruction following the preferences."""
    explicit_pref = []
    implicit_pref = []
    for memory in memories:
        pref_type = memory.get("metadata", {}).get("preference_type")
        if pref_type == "explicit_preference":
            pref = memory.get("metadata", {}).get("explicit_preference", None)
            if pref:
                explicit_pref.append(pref)
        elif pref_type == "implicit_preference":
            pref = memory.get("metadata", {}).get("implicit_preference", None)
            if pref:
                implicit_pref.append(pref)

    explicit_pref_str = (
        "Explicit Preference:\n"
        + "\n".join(f"{i + 1}. {pref}" for i, pref in enumerate(explicit_pref))
        if explicit_pref
        else ""
    )
    implicit_pref_str = (
        "Implicit Preference:\n"
        + "\n".join(f"{i + 1}. {pref}" for i, pref in enumerate(implicit_pref))
        if implicit_pref
        else ""
    )

    if not explicit_pref_str and not implicit_pref_str:
        return ""
    if not explicit_pref_str:
        return implicit_pref_str + "\n" + PREF_INSTRUCTIONS.replace("explicit preferences > ", "")
    if not implicit_pref_str:
        return explicit_pref_str + "\n" + PREF_INSTRUCTIONS.replace("implicit preferences > ", "")

    return explicit_pref_str + "\n" + implicit_pref_str + "\n" + PREF_INSTRUCTIONS
