import os
import sys


sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from prompts import PREF_INSTRUCTIONS


def create_mem_string(relevant_memories) -> str:
    text_memories = []
    explicit = []
    implicit = []
    for item in relevant_memories["text_mem"]:
        for mem in item["memories"]:
            text_memories.append(mem["memory"])
    text_memories_text = "\n".join(f"{i + 1}. {mem}" for i, mem in enumerate(text_memories)).strip()
    text_context = f"Plaintext Memory:\n{text_memories_text}\n" if text_memories_text else ""

    for item in relevant_memories.get("prefs", []):
        for mem in item["memories"]:
            if mem["metadata"]["preference_type"] == "explicit_preference":
                explicit.append(mem["metadata"]["explicit_preference"])
            elif mem["metadata"]["preference_type"] == "implicit_preference":
                implicit.append(mem["metadata"]["implicit_preference"])
    explicit_text = "\n".join(f"{i + 1}. {pref}" for i, pref in enumerate(explicit)).strip()
    explicit_context = f"Explicit Preference:\n{explicit_text}\n" if explicit_text else ""
    implicit_text = "\n".join(f"{i + 1}. {pref}" for i, pref in enumerate(implicit)).strip()
    implicit_context = f"Implicit Preference:\n{implicit_text}\n" if implicit_text else ""
    return text_context + explicit_context + implicit_context


def remove_pref_mem_from_mem_string(mem_string: str, frame: str) -> str:
    if os.getenv("ABLATION_PREF", "false").lower() == "true" and frame == "memos-api":
        tmp_list = mem_string.split("Plaintext Memory:")
        if len(tmp_list) > 1:
            return tmp_list[1].split("Explicit Preference:")[0]
    return mem_string


def add_pref_instruction(template: str, frame: str):
    if os.getenv("INSTRUCT_COMPLETE", "false").lower() == "true" and frame == "memos-api":
        return template.replace("{pref_instructions}", PREF_INSTRUCTIONS)
    return template.replace("{pref_instructions}", "")
