from typing import Any

from memos.mem_reader.simple_struct import detect_lang
from memos.templates.prefer_complete_prompt import PREF_INSTRUCTIONS, PREF_INSTRUCTIONS_ZH


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

    _prompt_map = {
        "zh": PREF_INSTRUCTIONS_ZH,
        "en": PREF_INSTRUCTIONS,
    }
    _remove_exp_map = {
        "zh": "显式偏好 > ",
        "en": "explicit preference > ",
    }
    _remove_imp_map = {
        "zh": "隐式偏好 > ",
        "en": "implicit preference > ",
    }
    lang = detect_lang(explicit_pref_str + implicit_pref_str)

    if not explicit_pref_str and not implicit_pref_str:
        return ""
    if not explicit_pref_str:
        return implicit_pref_str + "\n" + _prompt_map[lang].replace(_remove_exp_map[lang], "")
    if not implicit_pref_str:
        return explicit_pref_str + "\n" + _prompt_map[lang].replace(_remove_imp_map[lang], "")

    return explicit_pref_str + "\n" + implicit_pref_str + "\n" + _prompt_map[lang]
