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

    if old_len < 200:
        return change_ratio < 0.5
    else:
        return change_ratio < 0.2


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
