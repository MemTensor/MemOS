import json

from functools import wraps
from pathlib import Path

import yaml

from memos.log import get_logger


logger = get_logger(__name__)


def extract_json_dict(text: str):
    text = text.strip()
    patterns_to_remove = ["json```", "```python", "```json", "latex```", "```latex", "```"]
    for pattern in patterns_to_remove:
        text = text.replace(pattern, "")
    res = json.loads(text.strip())
    return res


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
