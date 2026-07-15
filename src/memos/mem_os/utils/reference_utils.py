from memos.memories.textual.item import (
    TextualMemoryItem,
)


def split_continuous_references(text: str) -> str:
    """
    Split continuous reference tags into individual reference tags.

    Converts patterns like [1:92ff35fb, 4:bfe6f044] to [1:92ff35fb] [4:bfe6f044]

    Only processes text if:
    1. '[' appears exactly once
    2. ']' appears exactly once
    3. Contains commas between '[' and ']'

    Args:
        text (str): Text containing reference tags

    Returns:
        str: Text with split reference tags, or original text if conditions not met
    """
    # Early return if text is empty
    if not text:
        return text
    # Check if '[' appears exactly once
    if text.count("[") != 1:
        return text
    # Check if ']' appears exactly once
    if text.count("]") != 1:
        return text
    # Find positions of brackets
    open_bracket_pos = text.find("[")
    close_bracket_pos = text.find("]")

    # Check if brackets are in correct order
    if open_bracket_pos >= close_bracket_pos:
        return text
    # Extract content between brackets
    content_between_brackets = text[open_bracket_pos + 1 : close_bracket_pos]
    # Check if there's a comma between brackets
    if "," not in content_between_brackets:
        return text
    text = text.replace(content_between_brackets, content_between_brackets.replace(", ", "]["))
    text = text.replace(content_between_brackets, content_between_brackets.replace(",", "]["))

    return text


def process_streaming_references_complete(text_buffer: str) -> tuple[str, str]:
    """
    Complete streaming reference processing to ensure reference tags are never split.

    Args:
        text_buffer (str): The accumulated text buffer.

    Returns:
        tuple[str, str]: (processed_text, remaining_buffer)
    """
    import re

    # Pattern to match complete reference tags: [refid:memoriesID]
    complete_pattern = r"\[\d+:[^\]]+\]"

    # Find all complete reference tags
    complete_matches = list(re.finditer(complete_pattern, text_buffer))

    if complete_matches:
        # Find the last complete tag
        last_match = complete_matches[-1]
        end_pos = last_match.end()

        # Check if there's any incomplete reference after the last complete one
        remaining_text = text_buffer[end_pos:]

        # Look for potential incomplete reference patterns after the last complete tag
        incomplete_pattern = r"\[\d*:?[^\]]*$"
        if re.search(incomplete_pattern, remaining_text):
            # There's a potential incomplete reference, find where it starts
            incomplete_match = re.search(incomplete_pattern, remaining_text)
            if incomplete_match:
                incomplete_start = end_pos + incomplete_match.start()
                processed_text = text_buffer[:incomplete_start]
                remaining_buffer = text_buffer[incomplete_start:]

                # Apply reference splitting to the processed text
                processed_text = split_continuous_references(processed_text)
                return processed_text, remaining_buffer

        # No incomplete reference after the last complete tag, process all
        processed_text = split_continuous_references(text_buffer)
        return processed_text, ""

    # Check for incomplete reference tags - be more specific about what constitutes a potential reference
    # Look for opening bracket with number and colon that could be a reference tag
    opening_pattern = r"\[\d+:"
    opening_matches = list(re.finditer(opening_pattern, text_buffer))

    if opening_matches:
        # Find the last opening tag
        last_opening = opening_matches[-1]
        opening_start = last_opening.start()

        # Check if this might be a complete reference tag (has closing bracket after the pattern)
        remaining_text = text_buffer[last_opening.end() :]
        if "]" in remaining_text:
            # This looks like a complete reference tag, process it
            processed_text = split_continuous_references(text_buffer)
            return processed_text, ""
        else:
            # Incomplete reference tag, keep it in buffer
            processed_text = text_buffer[:opening_start]
            processed_text = split_continuous_references(processed_text)
            return processed_text, text_buffer[opening_start:]

    # More sophisticated check for potential reference patterns
    # Only hold back text if we see a pattern that could be the start of a reference tag
    potential_ref_pattern = r"\[\d*:?$"  # Matches [, [1, [12:, etc. at end of buffer
    if re.search(potential_ref_pattern, text_buffer):
        # Find the position of the potential reference start
        match = re.search(potential_ref_pattern, text_buffer)
        if match:
            ref_start = match.start()
            processed_text = text_buffer[:ref_start]
            processed_text = split_continuous_references(processed_text)
            return processed_text, text_buffer[ref_start:]

    # Check for standalone [ only at the very end of the buffer
    # This prevents cutting off mathematical expressions like [ \Delta U = Q - W ]
    if text_buffer.endswith("["):
        # Only hold back the single [ character
        processed_text = text_buffer[:-1]
        processed_text = split_continuous_references(processed_text)
        return processed_text, "["

    # No reference-like patterns found, process all text
    processed_text = split_continuous_references(text_buffer)
    return processed_text, ""


def prepare_reference_data(memories_list: list[TextualMemoryItem]) -> list[dict]:
    # Prepare reference data
    reference = []
    for memories in memories_list:
        if isinstance(memories, TextualMemoryItem):
            memories_json = memories.model_dump()
            memories_json["metadata"]["ref_id"] = f"{memories.id.split('-')[0]}"
            memories_json["metadata"]["embedding"] = []
            memories_json["metadata"]["sources"] = []
            memories_json["metadata"]["memory"] = memories.memory
            memories_json["metadata"]["id"] = memories.id
            reference.append({"metadata": memories_json["metadata"]})
        else:
            memories_json = memories
            memories_json["metadata"]["ref_id"] = f"{memories_json['id'].split('-')[0]}"
            memories_json["metadata"]["embedding"] = []
            memories_json["metadata"]["sources"] = []
            memories_json["metadata"]["memory"] = memories_json["memory"]
            memories_json["metadata"]["id"] = memories_json["id"]
            reference.append({"metadata": memories_json["metadata"]})

    return reference
