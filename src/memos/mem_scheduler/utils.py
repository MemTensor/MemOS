import json
import re

from pathlib import Path

import yaml


def extract_json_dict(text: str):
    text = text.strip()
    patterns_to_remove = ["json```", "```json", "latex```", "```latex", "```"]
    for pattern in patterns_to_remove:
        text = text.replace(pattern, "")
    res = json.loads(text.strip())
    return res


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


def parse_yaml(yaml_file):
    yaml_path = Path(yaml_file)
    yaml_path = Path(yaml_file)
    if not yaml_path.is_file():
        raise FileNotFoundError(f"No such file: {yaml_file}")

    with yaml_path.open("r", encoding="utf-8") as fr:
        data = yaml.safe_load(fr)

    return data


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
