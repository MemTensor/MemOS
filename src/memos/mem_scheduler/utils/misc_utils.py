import json
import re

from functools import wraps
from pathlib import Path

import yaml

from memos.log import get_logger


logger = get_logger(__name__)


def extract_json_dict(text: str):
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
        logger.error(f"Failed to parse JSON from text: {text}. Error: {e!s}", exc_info=True)

    # Fallback 1: Extract JSON using regex
    json_pattern = r"\{[\s\S]*\}|\[[\s\S]*\]"
    matches = re.findall(json_pattern, text)
    if matches:
        try:
            return json.loads(matches[0])
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON from text: {text}. Error: {e!s}", exc_info=True)

    # Fallback 2: Handle malformed JSON (common LLM issues)
    try:
        # Try adding missing quotes around keys
        text = re.sub(r"([\{\s,])(\w+)(:)", r'\1"\2"\3', text)
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse JSON from text: {text}. Error: {e!s}", exc_info=True)
        raise ValueError(text) from e


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
                logger.error(f"Error in {func.__name__}: {e}", exc_info=True)

        return wrapper

    return decorator
