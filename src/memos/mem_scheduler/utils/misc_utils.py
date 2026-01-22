import os

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
