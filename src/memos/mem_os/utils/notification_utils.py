"""
Notification utilities for MemOS product.
"""

import logging
from typing import Any, Dict, Optional, Callable

logger = logging.getLogger(__name__)


def send_online_bot_notification(
    online_bot: Optional[Callable],
    header_name: str,
    sub_title_name: str,
    title_color: str,
    other_data1: Dict[str, Any],
    other_data2: Dict[str, Any],
    emoji: Dict[str, str],
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


def send_error_bot_notification(
    error_bot: Optional[Callable],
    err: str,
    title: str = "MemOS Error",
    level: str = "P2",
    user_ids: Optional[list] = None,
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
    error_bot: Optional[Callable],
    error_message: str,
    title: str = "MemOS Error",
    level: str = "P2",
) -> None:
    """
    Send error alert if error_bot is available (backward compatibility).
    """
    send_error_bot_notification(error_bot, error_message, title, level) 