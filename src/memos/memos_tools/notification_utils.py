"""
Notification utilities for MemOS product.
"""

import asyncio
import logging

from collections.abc import Callable
from typing import Any


logger = logging.getLogger(__name__)


def send_online_bot_notification(
    online_bot: Callable | None,
    header_name: str,
    sub_title_name: str,
    title_color: str,
    other_data1: dict[str, Any],
    other_data2: dict[str, Any],
    emoji: dict[str, str],
) -> None:
    """
    Send notification via online_bot if available.

    Args:
        online_bot: The online_bot function or None
        header_name: Header name for the report
        sub_title_name: Subtitle for the report
        title_color: Title color
        other_data1: First data dict
        other_data2: Second data dict
        emoji: Emoji configuration dict
    """
    if online_bot is None:
        return

    try:
        online_bot(
            header_name=header_name,
            sub_title_name=sub_title_name,
            title_color=title_color,
            other_data1=other_data1,
            other_data2=other_data2,
            emoji=emoji,
        )

        logger.info(f"Online bot notification sent successfully: {header_name}")

    except Exception as e:
        logger.warning(f"Failed to send online bot notification: {e}")


async def send_online_bot_notification_async(
    online_bot: Callable | None,
    header_name: str,
    sub_title_name: str,
    title_color: str,
    other_data1: dict[str, Any],
    other_data2: dict[str, Any],
    emoji: dict[str, str],
) -> None:
    """
    Send notification via online_bot asynchronously if available.

    Args:
        online_bot: The online_bot function or None
        header_name: Header name for the report
        sub_title_name: Subtitle for the report
        title_color: Title color
        other_data1: First data dict
        other_data2: Second data dict
        emoji: Emoji configuration dict
    """
    if online_bot is None:
        return

    try:
        # Run the potentially blocking notification in a thread pool
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: online_bot(
                header_name=header_name,
                sub_title_name=sub_title_name,
                title_color=title_color,
                other_data1=other_data1,
                other_data2=other_data2,
                emoji=emoji,
            ),
        )

        logger.info(f"Online bot notification sent successfully (async): {header_name}")

    except Exception as e:
        logger.warning(f"Failed to send online bot notification (async): {e}")


def send_error_bot_notification(
    error_bot: Callable | None,
    err: str,
    title: str = "MemOS Error",
    level: str = "P2",
    user_ids: list | None = None,
) -> None:
    """
    Send error alert if error_bot is available.

    Args:
        error_bot: The error_bot function or None
        err: Error message
        title: Alert title
        level: Alert level (P0, P1, P2)
        user_ids: List of user IDs to notify
    """
    if error_bot is None:
        return

    try:
        error_bot(
            err=err,
            title=title,
            level=level,
            user_ids=user_ids or [],
        )
        logger.info(f"Error alert sent successfully: {title}")
    except Exception as e:
        logger.warning(f"Failed to send error alert: {e}")


# Keep backward compatibility
def send_error_alert(
    error_bot: Callable | None,
    error_message: str,
    title: str = "MemOS Error",
    level: str = "P2",
) -> None:
    """
    Send error alert if error_bot is available (backward compatibility).
    """
    send_error_bot_notification(error_bot, error_message, title, level)
