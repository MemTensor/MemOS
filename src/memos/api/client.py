import json
import os

from typing import Any

import requests

from memos.log import get_logger


logger = get_logger(__name__)

MAX_RETRY_COUNT = 3


class MemOSClient:
    """MemOS API client"""

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        self.base_url = (
            base_url or os.getenv("MEMOS_BASE_URL") or "https://memos.memtensor.cn/api/openmem"
        )
        api_key = api_key or os.getenv("MEMOS_API_KEY")

        if not api_key:
            raise ValueError("MemOS API key is required")

        self.headers = {"Content-Type": "application/json", "Authorization": f"Token {api_key}"}

    def _validate_required_params(self, **params):
        """Validate required parameters - if passed, they must not be empty"""
        for param_name, param_value in params.items():
            if not param_value:
                raise ValueError(f"{param_name} is required")

    def add(self, messages: list[dict[str, Any]], user_id: str, conversation_id: str) -> str:
        """Add memories"""
        # Validate required parameters
        self._validate_required_params(
            messages=messages, user_id=user_id, conversation_id=conversation_id
        )

        url = f"{self.base_url}/add/message"
        payload = {"messages": messages, "userId": user_id, "conversationId": conversation_id}

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                return response.text
            except Exception as e:
                logger.error(f"Failed to add memory (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def search(self, query: str, filters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Search memories with flexible filtering

        Args:
            query: Search query string
            filters: Filter conditions for search scope

        Filters Format:
            {
                "user_id": "user1",                 # Required, single user ID
                "memory_limit_number": 6,           # Optional, defaults to 6
                "conversation_id": "conv1"          # Optional, single conversation ID
            }

        Usage Examples:
            # Basic search with single user and conversation
            search("Python", {"user_id": "user1", "conversation_id": "conv1"})

            # Search with custom limit
            search("Python", {"user_id": "user1", "memory_limit_number": 10})

            # Search only by user (all conversations)
            search("Python", {"user_id": "user1"})

            # Search only by conversation for a specific user
            search("Python", {"user_id": "user1", "conversation_id": "conv1"})

        Returns:
            List of memory dictionaries matching the search criteria
        """

        # Set default filters if not provided
        if filters is None:
            filters = {}

        # Extract filter values with defaults
        memory_limit_number = filters.get("memory_limit_number", 6)
        user_id = filters.get("user_id")
        conversation_id = filters.get("conversation_id")

        # Validate required parameters
        self._validate_required_params(query=query, user_id=user_id)

        url = f"{self.base_url}/search/memory"
        payload = {
            "query": query,
            "userId": user_id,
        }

        # Add optional conversation_id to payload
        if conversation_id:
            payload["conversationId"] = conversation_id

        if memory_limit_number:
            payload["memoryLimitNumber"] = memory_limit_number

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                return response.text
            except Exception as e:
                logger.error(f"Failed to search memory (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise
