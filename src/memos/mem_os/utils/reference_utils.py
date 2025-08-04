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

        # Get text up to the end of the last complete tag
        processed_text = text_buffer[:end_pos]
        remaining_buffer = text_buffer[end_pos:]

        # Apply reference splitting to the processed text
        processed_text = split_continuous_references(processed_text)

        return processed_text, remaining_buffer

    # Check for incomplete reference tags
    # Look for opening bracket with number and colon
    opening_pattern = r"\[\d+:"
    opening_matches = list(re.finditer(opening_pattern, text_buffer))

    if opening_matches:
        # Find the last opening tag
        last_opening = opening_matches[-1]
        opening_start = last_opening.start()

        # Check if we have a complete opening pattern
        if last_opening.end() <= len(text_buffer):
            # We have a complete opening pattern, keep everything in buffer
            return "", text_buffer
        else:
            # Incomplete opening pattern, return text before it
            processed_text = text_buffer[:opening_start]
            # Apply reference splitting to the processed text
            processed_text = split_continuous_references(processed_text)
            return processed_text, text_buffer[opening_start:]

    # Check for partial opening pattern (starts with [ but not complete)
    if "[" in text_buffer:
        ref_start = text_buffer.find("[")
        processed_text = text_buffer[:ref_start]
        # Apply reference splitting to the processed text
        processed_text = split_continuous_references(processed_text)
        return processed_text, text_buffer[ref_start:]

    # No reference tags found, apply reference splitting and return all text
    processed_text = split_continuous_references(text_buffer)
    return processed_text, ""
