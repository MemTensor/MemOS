from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessageList


def build_system_prompt(
    memories: list[TextualMemoryItem] | None = None,
    instruction_strategy: str = "process_conflict"):
    # Initialize all memory lists
    mems = {
        "textual_mems": [],
        "explicit_prefs": [],
        "implicit_prefs": [],
    }

    for memory in memories:
        if memory.metadata.preference_type == "explicit_preference":
            mems["explicit_prefs"].append(memory.metadata.explicit_preference)
        elif memory.metadata.preference_type == "implicit_preference":
            mems["implicit_prefs"].append(memory.metadata.implicit_preference)
        else:
            mems["textual_mems"].append(memory.memory)

    # Build memories string with different titles for different types
    memories_parts = []
    if mems["textual_mems"]:
        memories_parts.append("## Textual Memories:")
        for i, mem in enumerate(mems["textual_mems"], 1):
            memories_parts.append(f"{i}. {mem}")
    if mems["explicit_prefs"]:
        memories_parts.append("## Explicit Preferences:")
        for i, pref in enumerate(mems["explicit_prefs"], 1):
            memories_parts.append(f"{i}. {pref}")

    if mems["implicit_prefs"]:
        memories_parts.append("\n## Implicit Preferences:")
        for i, pref in enumerate(mems["implicit_prefs"], 1):
            memories_parts.append(f"{i}. {pref}")

    memories_str = "\n".join(memories_parts)

    system_prompt = (
        "You are a knowledgeable and helpful AI assistant. "
        "You have access to conversation memories that help you provide more personalized responses. "
        "Use the memories to understand the user's context, preferences, and past interactions. "
        "If memories are provided, reference them naturally when relevant, but don't explicitly mention having memories."
        "\n\n# Memories:\n{memories}"
    )

    if instruction_strategy == "raw":
        system_prompt = system_prompt.replace("{memories}", memories_str)
    elif instruction_strategy == "process_conflict":
        system_prompt = (
            system_prompt
            + (
                "\nNote: Textual memories are summaries of facts, while preference memories are summaries of user preferences. "
                + "Your response must not violate any of the user's preferences, whether explicit or implicit, and briefly explain why you answer this way to avoid conflicts."
                + "When encountering preference conflicts, the priority is: explicit preferences > textual memories > implicit preferences."
            )
        ).replace("{memories}", memories_str)
    else:
        raise ValueError(f"Invalid instruction strategy: {instruction_strategy}")

    return system_prompt


def get_instruction(
    query: str,
    memories: list[TextualMemoryItem] | None = None,
    history: MessageList | None = None,
    instruction_strategy: str = "process_conflict"
) -> str:
    """Create instruction following the memories, preference and tool information."""

    system_prompt = build_system_prompt(memories, instruction_strategy)
        
    messages = [
        {"role": "system", "content": system_prompt},
        *history,
        {"role": "user", "content": query},
    ]

    return messages
