import json
import os

from typing import Any

import requests

from memos.api.product_models import MemOSAddResponse, MemOSGetMessagesResponse, MemOSSearchResponse
from memos.log import get_logger


logger = get_logger(__name__)

MAX_RETRY_COUNT = 3


class MemOSClient:
    """MemOS API client"""

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        self.base_url = (
            base_url or os.getenv("MEMOS_BASE_URL") or "https://memos.memtensor.cn/api/openmem/v1"
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

    def get_message(
        self, user_id: str, conversation_id: str | None = None
    ) -> MemOSGetMessagesResponse:
        """Get messages"""
        # Validate required parameters
        self._validate_required_params(user_id=user_id)

        url = f"{self.base_url}/get/message"
        payload = {"user_id": user_id, "conversation_id": conversation_id}
        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSGetMessagesResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to get messages (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def add_message(
        self, messages: list[dict[str, Any]], user_id: str, conversation_id: str
    ) -> MemOSAddResponse:
        """Add memories"""
        # Validate required parameters
        self._validate_required_params(
            messages=messages, user_id=user_id, conversation_id=conversation_id
        )

        url = f"{self.base_url}/add/message"
        payload = {"messages": messages, "user_id": user_id, "conversation_id": conversation_id}
        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSAddResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to add memory (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def search_memory(
        self, query: str, user_id: str, conversation_id: str, memory_limit_number: int = 6
    ) -> MemOSSearchResponse:
        """Search memories"""
        # Validate required parameters
        self._validate_required_params(query=query, user_id=user_id)

        url = f"{self.base_url}/search/memory"
        payload = {
            "query": query,
            "user_id": user_id,
            "conversation_id": conversation_id,
            "memory_limit_number": memory_limit_number,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSSearchResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to search memory (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise
