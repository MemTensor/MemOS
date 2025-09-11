import re

from memos.dependency import require_python_package
from memos.log import get_logger


logger = get_logger(__name__)


def transform_name_to_key(name):
    """
    Normalize text by removing all punctuation marks, keeping only letters, numbers, and word characters.

    Args:
        name (str): Input text to be processed

    Returns:
        str: Processed text with all punctuation removed
    """
    # Match all characters that are NOT:
    # \w - word characters (letters, digits, underscore)
    # \u4e00-\u9fff - Chinese/Japanese/Korean characters
    # \s - whitespace
    pattern = r"[^\w\u4e00-\u9fff\s]"

    # Substitute all matched punctuation marks with empty string
    # re.UNICODE flag ensures proper handling of Unicode characters
    normalized = re.sub(pattern, "", name, flags=re.UNICODE)

    # Optional: Collapse multiple whitespaces into single space
    normalized = "_".join(normalized.split())

    normalized = normalized.lower()

    return normalized


def is_all_english(input_string: str) -> bool:
    """Determine if the string consists entirely of English characters (including spaces)"""
    return all(char.isascii() or char.isspace() for char in input_string)


def is_all_chinese(input_string: str) -> bool:
    """Determine if the string consists entirely of Chinese characters (including Chinese punctuation and spaces)"""
    return all(
        ("\u4e00" <= char <= "\u9fff")  # Basic Chinese characters
        or ("\u3400" <= char <= "\u4dbf")  # Extension A
        or ("\u20000" <= char <= "\u2a6df")  # Extension B
        or ("\u2a700" <= char <= "\u2b73f")  # Extension C
        or ("\u2b740" <= char <= "\u2b81f")  # Extension D
        or ("\u2b820" <= char <= "\u2ceaf")  # Extension E
        or ("\u2f800" <= char <= "\u2fa1f")  # Extension F
        or char.isspace()  # Spaces
        for char in input_string
    )


@require_python_package(
    import_name="sklearn",
    install_command="pip install scikit-learn",
    install_link="https://scikit-learn.org/stable/install.html",
)
def filter_vector_based_similar_memories(
    text_memories: list[str], similarity_threshold: float = 0.75
) -> list[str]:
    """
    Filters out low-quality or duplicate memories based on text similarity.

    Args:
        text_memories: List of text memories to filter
        similarity_threshold: Threshold for considering memories duplicates (0.0-1.0)
                            Higher values mean stricter filtering

    Returns:
        List of filtered memories with duplicates removed
    """
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity

    if not text_memories:
        logger.warning("Received empty memories list - nothing to filter")
        return []

    for idx in range(len(text_memories)):
        if not isinstance(text_memories[idx], str):
            logger.error(
                f"{text_memories[idx]} in memories is not a string,"
                f" and now has been transformed to be a string."
            )
            text_memories[idx] = str(text_memories[idx])

    try:
        # Step 1: Vectorize texts using TF-IDF
        vectorizer = TfidfVectorizer()
        tfidf_matrix = vectorizer.fit_transform(text_memories)

        # Step 2: Calculate pairwise similarity matrix
        similarity_matrix = cosine_similarity(tfidf_matrix)

        # Step 3: Identify duplicates
        to_keep = set(range(len(text_memories)))  # Start with all indices
        for i in range(len(similarity_matrix)):
            if i not in to_keep:
                continue  # Already marked for removal

            # Find all similar items to this one (excluding self and already removed)
            similar_indices = [
                j
                for j in range(i + 1, len(similarity_matrix))
                if similarity_matrix[i][j] >= similarity_threshold and j in to_keep
            ]
            similar_indices = set(similar_indices)

            # Remove all similar items (keeping the first one - i)
            to_keep -= similar_indices

        # Return filtered memories
        filtered_memories = [text_memories[i] for i in sorted(to_keep)]
        logger.debug(f"filtered_memories: {filtered_memories}")
        return filtered_memories

    except Exception as e:
        logger.error(f"Error filtering memories: {e!s}")
        return text_memories  # Return original list if error occurs


def filter_too_short_memories(
    text_memories: list[str], min_length_threshold: int = 20
) -> list[str]:
    """
    Filters out text memories that fall below the minimum length requirement.
    Handles both English (word count) and Chinese (character count) differently.

    Args:
        text_memories: List of text memories to be filtered
        min_length_threshold: Minimum length required to keep a memory.
                            For English: word count, for Chinese: character count.

    Returns:
        List of filtered memories meeting the length requirement
    """
    if not text_memories:
        logger.debug("Empty memories list received in short memory filter")
        return []

    filtered_memories = []
    removed_count = 0

    for memory in text_memories:
        stripped_memory = memory.strip()
        if not stripped_memory:  # Skip empty/whitespace memories
            removed_count += 1
            continue

        # Determine measurement method based on language
        if is_all_english(stripped_memory):
            length = len(stripped_memory.split())  # Word count for English
        elif is_all_chinese(stripped_memory):
            length = len(stripped_memory)  # Character count for Chinese
        else:
            logger.debug(f"Mixed-language memory, using character count: {stripped_memory[:50]}...")
            length = len(stripped_memory)  # Default to character count

        if length >= min_length_threshold:
            filtered_memories.append(memory)
        else:
            removed_count += 1

    if removed_count > 0:
        logger.info(
            f"Filtered out {removed_count} short memories "
            f"(below {min_length_threshold} units). "
            f"Total remaining: {len(filtered_memories)}"
        )

    return filtered_memories
