import json
import re

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


def estimate_tokens(text: str) -> int:
    """
    Estimate the approximate number of tokens for the text
    """
    if not text:
        return 0

    chinese_chars = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")

    english_parts = text.split()
    english_words = 0
    for part in english_parts:
        has_chinese = any("\u4e00" <= char <= "\u9fff" for char in part)
        if not has_chinese and any(c.isalpha() for c in part):
            english_words += 1

    other_chars = len(text) - chinese_chars

    estimated_tokens = int(chinese_chars * 1.5 + english_words * 1.33 + other_chars * 0.5)

    return max(1, estimated_tokens)


def should_keep_update(new_text: str, old_text: str) -> bool:
    """
    Determine whether the update should be skipped
        Rule:
        1. If the length of old_text is less than 50 and the modification ratio is less than 50% => returns True
        2. If the length of old_text is greater than or equal to 50 and the modification ratio is less than 15% => returns True
        3. Return False in other cases
    """

    old_len = estimate_tokens(old_text)

    def calculate_similarity(text1: str, text2: str) -> float:
        set1 = set(text1)
        set2 = set(text2)
        if not set1 and not set2:
            return 1.0

        intersection = len(set1.intersection(set2))
        union = len(set1.union(set2))
        return intersection / union if union > 0 else 0.0

    similarity = calculate_similarity(old_text, new_text)
    change_ratio = 1 - similarity

    if change_ratio == float(0):
        return False

    if old_len < 200:
        return change_ratio < 0.7
    else:
        return change_ratio < 0.2


def general_split_into_chunks(items: list[dict], max_tokens_per_chunk: int = 500):
    chunks = []
    current_chunk = []
    current_tokens = 0

    for item in items:
        item_text = str(item)
        item_tokens = estimate_tokens(item_text)

        if item_tokens > max_tokens_per_chunk:
            if current_chunk:
                chunks.append(current_chunk)
                current_chunk = []

            chunks.append([item])
            current_tokens = 0

        elif current_tokens + item_tokens <= max_tokens_per_chunk:
            current_chunk.append(item)
            current_tokens += item_tokens
        else:
            if current_chunk:
                chunks.append(current_chunk)
            current_chunk = [item]
            current_tokens = item_tokens

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def split_into_chunks(memories: list[TextualMemoryItem], max_tokens_per_chunk: int = 500):
    chunks = []
    current_chunk = []
    current_tokens = 0

    for item in memories:
        item_text = f"{item.id}: {item.memory}"
        item_tokens = estimate_tokens(item_text)

        if item_tokens > max_tokens_per_chunk:
            if current_chunk:
                chunks.append(current_chunk)
                current_chunk = []

            chunks.append([item])
            current_tokens = 0

        elif current_tokens + item_tokens <= max_tokens_per_chunk:
            current_chunk.append(item)
            current_tokens += item_tokens
        else:
            if current_chunk:
                chunks.append(current_chunk)
            current_chunk = [item]
            current_tokens = item_tokens

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def make_mem_item(text: str, **kwargs) -> TextualMemoryItem:
    """Build a minimal TextualMemoryItem."""
    info = kwargs.get("info", {})
    info_ = info.copy()
    user_id = info_.pop("user_id", "")
    session_id = info_.pop("session_id", "")

    return TextualMemoryItem(
        memory=text,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=user_id,
            session_id=session_id,
            memory_type="LongTermMemory",
            status="activated",
            tags=kwargs.get("tags", []),
            key=kwargs.get("key", ""),
            embedding=kwargs.get("embedding", []),
            usage=[],
            sources=kwargs.get("sources", []),
            user_name=kwargs.get("user_name", ""),
            background=kwargs.get("background", ""),
            confidence=0.99,
            type=kwargs.get("type", ""),
            info=info_,
        ),
    )


def extract_bracket_content(text):
    """
    Extract and parse JSON content enclosed in curly braces {} from text.
    """
    # Strategy 1: Greedy match to capture the outermost complete brace pair
    greedy_match = re.search(r"\{.*\}", text, re.DOTALL)
    if greedy_match is None:
        error_msg = f"No curly brace content found in text: {text}"
        raise ValueError(error_msg)

    greedy_content = greedy_match.group(0)

    # Strategy 2: Non-greedy match to find all brace pairs, use the last one
    non_greedy_matches = re.findall(r"\{.*?\}", text, re.DOTALL)
    if not non_greedy_matches:
        error_msg = f"No curly brace content found in text: {text}"
        raise ValueError(error_msg)

    non_greedy_content = non_greedy_matches[-1]

    for content in [greedy_content, non_greedy_content]:
        try:
            parsed_data = json.loads(content)
            return parsed_data
        except json.JSONDecodeError:
            continue

    for content in [greedy_content, non_greedy_content]:
        try:
            fixed_content = content.replace("{{", "{").replace("}}", "}")
            parsed_data = json.loads(fixed_content)
            return parsed_data
        except json.JSONDecodeError:
            continue

    error_msg = f"Failed to parse JSON content from curly braces. Text preview: {text}"
    raise ValueError(error_msg)


def extract_square_brackets_content(text):
    """
    Extract and parse JSON content enclosed in square brackets [] from text.
    """
    # Strategy 1: Greedy match to capture the outermost complete bracket pair
    greedy_match = re.search(r"\[.*\]", text, re.DOTALL)
    if greedy_match is None:
        error_msg = f"No square bracket content found in text: {text}"
        raise ValueError(error_msg)

    greedy_content = greedy_match.group(0)

    # Strategy 2: Non-greedy match to find all bracket pairs, use the last one
    non_greedy_matches = re.findall(r"\[.*?\]", text, re.DOTALL)
    if not non_greedy_matches:
        error_msg = f"No square bracket content found in text: {text}"
        raise ValueError(error_msg)

    non_greedy_content = non_greedy_matches[-1]

    for content in [greedy_content, non_greedy_content]:
        try:
            parsed_data = json.loads(content)
            return parsed_data
        except json.JSONDecodeError:
            continue

    for content in [greedy_content, non_greedy_content]:
        try:
            fixed_content = content.replace("{{", "{").replace("}}", "}")
            parsed_data = json.loads(fixed_content)
            return parsed_data
        except json.JSONDecodeError:
            continue

    error_msg = f"Failed to parse JSON content from square brackets. Text preview: {text}"
    raise ValueError(error_msg)
