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


def normalize_name(text):
    """
    Normalize text by removing all punctuation marks, keeping only letters, numbers, and word characters.

    Args:
        text (str): Input text to be processed

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
    normalized = re.sub(pattern, "", text, flags=re.UNICODE)

    # Optional: Collapse multiple whitespaces into single space
    normalized = " ".join(normalized.split())

    return normalized


def parse_yaml(yaml_file):
    yaml_path = Path(yaml_file)
    yaml_path = Path(yaml_file)
    if not yaml_path.is_file():
        raise FileNotFoundError(f"No such file: {yaml_file}")

    with yaml_path.open("r", encoding="utf-8") as fr:
        data = yaml.safe_load(fr)

    return data
