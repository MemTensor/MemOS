import json
import os
import re
import traceback

from collections import defaultdict
from functools import wraps
from pathlib import Path

import yaml

from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import (
    ScheduleMessageItem,
)


logger = get_logger(__name__)


def _normalize_env_value(value: str | None) -> str:
    """Normalize environment variable values for comparison."""
    return value.strip().lower() if isinstance(value, str) else ""


def is_playground_env() -> bool:
    """Return True when ENV_NAME indicates a Playground environment."""
    env_name = _normalize_env_value(os.getenv("ENV_NAME"))
    return env_name.startswith("playground")


def is_cloud_env() -> bool:
    """
    Determine whether the scheduler should treat the runtime as a cloud environment.

    Rules:
    - Any Playground ENV_NAME is explicitly NOT cloud.
    - MEMSCHEDULER_RABBITMQ_EXCHANGE_NAME must be set to enable cloud behavior.
    - The default memos-fanout/fanout combination is treated as non-cloud.
    """
    if is_playground_env():
        return False

    exchange_name = _normalize_env_value(os.getenv("MEMSCHEDULER_RABBITMQ_EXCHANGE_NAME"))
    exchange_type = _normalize_env_value(os.getenv("MEMSCHEDULER_RABBITMQ_EXCHANGE_TYPE"))

    if not exchange_name:
        return False

    return not (
        exchange_name == "memos-fanout" and (not exchange_type or exchange_type == "fanout")
    )


def extract_json_obj(text: str):
    """
    Safely extracts JSON from LLM response text with robust error handling.

    Args:
        text: Raw text response from LLM that may contain JSON

    Returns:
        Parsed JSON data (dict or list)

    Raises:
        ValueError: If no valid JSON can be extracted
    """
    if not text:
        raise ValueError("Empty input text")

    # Normalize the text
    text = text.strip()

    # Remove common code block markers
    patterns_to_remove = ["json```", "```python", "```json", "latex```", "```latex", "```"]
    for pattern in patterns_to_remove:
        text = text.replace(pattern, "")

    # Try: direct JSON parse first
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError as e:
        logger.info(f"Failed to parse JSON from text: {text}. Error: {e!s}", exc_info=True)

    # Fallback 1: Extract JSON using regex
    json_pattern = r"\{[\s\S]*\}|\[[\s\S]*\]"
    matches = re.findall(json_pattern, text)
    if matches:
        try:
            return json.loads(matches[0])
        except json.JSONDecodeError as e:
            logger.info(f"Failed to parse JSON from text: {text}. Error: {e!s}", exc_info=True)

    # Fallback 2: Handle malformed JSON (common LLM issues)
    try:
        # Try adding missing quotes around keys
        text = re.sub(r"([\{\s,])(\w+)(:)", r'\1"\2"\3', text)
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse JSON from text: {text}. Error: {e!s}")
        logger.error("Full traceback:\n" + traceback.format_exc())
        raise ValueError(text) from e


def extract_list_items(text: str, bullet_prefixes: tuple[str, ...] = ("- ",)) -> list[str]:
    """
    Extract bullet list items from LLM output where each item is on a single line
    starting with a given bullet prefix (default: "- ").

    This function is designed to be robust to common LLM formatting variations,
    following similar normalization practices as `extract_json_obj`.

    Behavior:
    - Strips common code-fence markers (```json, ```python, ``` etc.).
    - Collects all lines that start with any of the provided `bullet_prefixes`.
    - Tolerates the "• " bullet as a loose fallback.
    - Unescapes common sequences like "\\n" and "\\t" within items.
    - If no bullet lines are found, falls back to attempting to parse a JSON array
      (using `extract_json_obj`) and returns its string elements.

    Args:
        text: Raw text response from LLM.
        bullet_prefixes: Tuple of accepted bullet line prefixes.

    Returns:
        List of extracted items (strings). Returns an empty list if none can be parsed.
    """
    if not text:
        return []

    # Normalize the text similar to extract_json_obj
    normalized = text.strip()
    patterns_to_remove = ["json```", "```python", "```json", "latex```", "```latex", "```"]
    for pattern in patterns_to_remove:
        normalized = normalized.replace(pattern, "")
    normalized = normalized.replace("\r\n", "\n")

    lines = normalized.splitlines()
    items: list[str] = []
    seen: set[str] = set()

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        matched = False
        for prefix in bullet_prefixes:
            if line.startswith(prefix):
                content = line[len(prefix) :].strip()
                content = content.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
                if content and content not in seen:
                    items.append(content)
                    seen.add(content)
                matched = True
                break

        if matched:
            continue

    if items:
        return items
    else:
        logger.error(f"Fail to parse {text}")

    return []


def extract_list_items_in_answer(
    text: str, bullet_prefixes: tuple[str, ...] = ("- ",)
) -> list[str]:
    """
    Extract list items specifically from content enclosed within `<answer>...</answer>` tags.

    - When one or more `<answer>...</answer>` blocks are present, concatenates their inner
      contents with newlines and parses using `extract_list_items`.
    - When no `<answer>` block is found, falls back to parsing the entire input with
      `extract_list_items`.
    - Case-insensitive matching of the `<answer>` tag.

    Args:
        text: Raw text that may contain `<answer>...</answer>` blocks.
        bullet_prefixes: Accepted bullet prefixes (default: strictly `"- "`).

    Returns:
        List of extracted items (strings), or an empty list when nothing is parseable.
    """
    if not text:
        return []

    try:
        normalized = text.strip().replace("\r\n", "\n")
        # Ordered, exact-case matching for <answer> blocks: answer -> Answer -> ANSWER
        tag_variants = ["answer", "Answer", "ANSWER"]
        matches: list[str] = []
        for tag in tag_variants:
            matches = re.findall(rf"<{tag}>([\\s\\S]*?)</{tag}>", normalized)
            if matches:
                break
        # Fallback: case-insensitive matching if none of the exact-case variants matched
        if not matches:
            matches = re.findall(r"<answer>([\\s\\S]*?)</answer>", normalized, flags=re.IGNORECASE)

        if matches:
            combined = "\n".join(m.strip() for m in matches if m is not None)
            return extract_list_items(combined, bullet_prefixes=bullet_prefixes)

        # Fallback: parse the whole text if tags are absent
        return extract_list_items(normalized, bullet_prefixes=bullet_prefixes)
    except Exception as e:
        logger.info(f"Failed to extract items within <answer> tags: {e!s}", exc_info=True)
        # Final fallback: attempt direct list extraction
        try:
            return extract_list_items(text, bullet_prefixes=bullet_prefixes)
        except Exception:
            return []


def parse_yaml(yaml_file: str | Path):
    yaml_path = Path(yaml_file)
    if not yaml_path.is_file():
        raise FileNotFoundError(f"No such file: {yaml_file}")

    with yaml_path.open("r", encoding="utf-8") as fr:
        data = yaml.safe_load(fr)

    return data


def log_exceptions(logger=logger):
    """
    Exception-catching decorator that automatically logs errors (including stack traces)

    Args:
        logger: Optional logger object (default: module-level logger)

    Example:
        @log_exceptions()
        def risky_function():
            raise ValueError("Oops!")

        @log_exceptions(logger=custom_logger)
        def another_risky_function():
            might_fail()
    """

    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                logger.error(f"Error in {func.__name__}: {e}", stack_info=True)

        return wrapper

    return decorator


def group_messages_by_user_and_mem_cube(
    messages: list[ScheduleMessageItem],
) -> dict[str, dict[str, list[ScheduleMessageItem]]]:
    """
    Groups messages into a nested dictionary structure first by user_id, then by mem_cube_id.

    Args:
        messages: List of ScheduleMessageItem objects to be grouped

    Returns:
        A nested dictionary with the structure:
        {
            "user_id_1": {
                "mem_cube_id_1": [msg1, msg2, ...],
                "mem_cube_id_2": [msg3, msg4, ...],
                ...
            },
            "user_id_2": {
                ...
            },
            ...
        }
        Where each msg is the original ScheduleMessageItem object
    """
    grouped_dict = defaultdict(lambda: defaultdict(list))

    for msg in messages:
        grouped_dict[msg.user_id][msg.mem_cube_id].append(msg)

    # Convert defaultdict to regular dict for cleaner output
    return {user_id: dict(cube_groups) for user_id, cube_groups in grouped_dict.items()}
