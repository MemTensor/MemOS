import json
import re

from memos.dependency import require_python_package
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessageList


def convert_messages_to_string(messages: MessageList) -> str:
    """Convert a list of messages to a string."""
    message_text = ""
    for message in messages:
        content = message.get("content", "")
        content = (
            content.strip()
            if isinstance(content, str)
            else json.dumps(content, ensure_ascii=False).strip()
        )
        if message["role"] == "system":
            continue
        if message["role"] == "user":
            message_text += f"User: {content}\n" if content else ""
        elif message["role"] == "assistant":
            tool_calls = message.get("tool_calls", [])
            tool_calls_str = (
                f"[tool_calls]: {json.dumps(tool_calls, ensure_ascii=False)}" if tool_calls else ""
            )
            line_str = (
                f"Assistant: {content} {tool_calls_str}".strip()
                if content or tool_calls_str
                else ""
            )
            message_text += f"{line_str}\n" if line_str else ""
        elif message["role"] == "tool":
            tool_call_id = message.get("tool_call_id", "")
            line_str = (
                f"Tool: {content} [tool_call_id]: {tool_call_id}".strip()
                if tool_call_id
                else f"Tool: {content}".strip()
            )
            message_text += f"{line_str}\n" if line_str else ""
    return message_text.strip()


@require_python_package(
    import_name="datasketch",
    install_command="pip install datasketch",
    install_link="https://github.com/ekzhu/datasketch",
)
def deduplicate_preferences(
    prefs: list[TextualMemoryItem], similarity_threshold: float = 0.6, num_perm: int = 256
) -> list[TextualMemoryItem]:
    """
    Deduplicate preference texts using MinHash algorithm.

    Args:
        prefs: List of preference memory items to deduplicate
        similarity_threshold: Jaccard similarity threshold (0.0-1.0), default 0.8

    Returns:
        Deduplicated list of preference items
    """
    from datasketch import MinHash, MinHashLSH

    if not prefs:
        return prefs

    # Use MinHashLSH for efficient similarity search
    lsh = MinHashLSH(threshold=similarity_threshold, num_perm=num_perm)
    unique_prefs = []

    for i, pref in enumerate(prefs):
        # Extract preference text
        if hasattr(pref.metadata, "preference") and pref.metadata.preference:
            text = pref.metadata.preference
        else:
            text = pref.memory

        # Create MinHash from text tokens
        minhash = MinHash(num_perm=num_perm)
        # Simple tokenization: split by whitespace and clean
        tokens = re.findall(r"\w+", text.lower())
        for token in tokens:
            minhash.update(token.encode("utf8"))

        # Check for duplicates using LSH
        similar_items = lsh.query(minhash)

        if not similar_items:  # No similar items found
            lsh.insert(i, minhash)
            unique_prefs.append(pref)

    return unique_prefs
