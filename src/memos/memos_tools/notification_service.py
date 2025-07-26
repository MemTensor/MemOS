"""
Simple online_bot integration utility.
"""

import logging

from collections.abc import Callable


logger = logging.getLogger(__name__)


def get_online_bot_function() -> Callable | None:
    """
    Get online_bot function if available, otherwise return None.

    Returns:
        online_bot function if available, None otherwise
    """
    try:
        from memos.memos_tools.dinding_report_bot import online_bot

        logger.info("online_bot function loaded successfully")
        return online_bot
    except ImportError as e:
        logger.warning(f"Failed to import online_bot: {e}, returning None")
        return None


def get_error_bot_function() -> Callable | None:
    """
    Get error_bot function if available, otherwise return None.

    Returns:
        error_bot function if available, None otherwise
    """
    try:
        from memos.memos_tools.dinding_report_bot import error_bot

        logger.info("error_bot function loaded successfully")
        return error_bot
    except ImportError as e:
        logger.warning(f"Failed to import error_bot: {e}, returning None")
        return None
