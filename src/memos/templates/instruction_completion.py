from typing import Any

from memos.mem_reader.read_multi_modal import detect_lang
from memos.templates.prefer_complete_prompt import PREF_INSTRUCTIONS, PREF_INSTRUCTIONS_ZH


def instruct_completion(
    memories: list[dict[str, Any]] | None = None,
) -> [str, str]:
    """Create instruction following the preferences."""
    explicit_pref = []
    implicit_pref = []
    for memory in memories:
        pref_type = memory.get("metadata", {}).get("preference_type")
        pref = memory.get("metadata", {}).get("preference", None)
        if not pref:
            continue
        if pref_type == "explicit_preference":
            explicit_pref.append(pref)
        elif pref_type == "implicit_preference":
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
    lang = detect_lang(
        explicit_pref_str.replace("Explicit Preference:\n", "")
        + implicit_pref_str.replace("Implicit Preference:\n", "")
    )

    if not explicit_pref_str and not implicit_pref_str:
        return "", ""
    if not explicit_pref_str:
        pref_note = _prompt_map[lang].replace(_remove_exp_map[lang], "")
        pref_string = implicit_pref_str + "\n" + pref_note
        return pref_string, pref_note
    if not implicit_pref_str:
        pref_note = _prompt_map[lang].replace(_remove_imp_map[lang], "")
        pref_string = explicit_pref_str + "\n" + pref_note
        return pref_string, pref_note

    pref_note = _prompt_map[lang]
    pref_string = explicit_pref_str + "\n" + implicit_pref_str + "\n" + pref_note
    return pref_string, pref_note
