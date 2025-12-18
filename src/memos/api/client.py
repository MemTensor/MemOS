import json
import mimetypes
import os

from typing import Any

import requests

from api.product_models import (
    MemOSAddFeedBackResponse,
    MemOSAddKnowledgebaseFileResponse,
    MemOSAddResponse,
    MemOSCreateKnowledgebaseResponse,
    MemOSDeleteKnowledgebaseResponse,
    MemOSDeleteMemoryResponse,
    MemOSGetKnowledgebaseFileResponse,
    MemOSGetMemoryResponse,
    MemOSGetMessagesResponse,
    MemOSGetTaskStatusResponse,
    MemOSSearchResponse,
)

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
        self,
        user_id: str,
        conversation_id: str | None = None,
        conversation_limit_number: int = 6,
        message_limit_number: int = 6,
        source: str | None = None,
    ) -> MemOSGetMessagesResponse | None:
        """Get messages"""
        # Validate required parameters
        self._validate_required_params(user_id=user_id)

        url = f"{self.base_url}/get/message"
        payload = {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "conversation_limit_number": conversation_limit_number,
            "message_limit_number": message_limit_number,
            "source": source,
        }
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
        self,
        messages: list[dict[str, Any]],
        user_id: str,
        conversation_id: str,
        info: dict[str, Any] | None = None,
        source: str | None = None,
        app_id: str | None = None,
        agent_id: str | None = None,
        async_mode: bool = True,
        tags: list[str] | None = None,
        allow_public: bool = False,
        allow_knowledgebase_ids: list[str] | None = None,
    ) -> MemOSAddResponse | None:
        """Add message"""
        # Validate required parameters
        self._validate_required_params(
            messages=messages, user_id=user_id, conversation_id=conversation_id
        )

        url = f"{self.base_url}/add/message"
        payload = {
            "messages": messages,
            "user_id": user_id,
            "conversation_id": conversation_id,
            "info": info,
            "source": source,
            "app_id": app_id,
            "agent_id": agent_id,
            "allow_public": allow_public,
            "allow_knowledgebase_ids": allow_knowledgebase_ids,
            "tags": tags,
            "asyncMode": async_mode,
        }
        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSAddResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to add message (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def search_memory(
        self,
        query: str,
        user_id: str,
        conversation_id: str,
        memory_limit_number: int = 6,
        include_preference: bool = True,
        knowledgebase_ids: list[str] | None = None,
        filter: dict[str, Any] | None = None,
        source: str | None = None,
        include_tool_memory: bool = False,
        preference_limit_number: int = 6,
        tool_memory_limit_number: int = 6,
    ) -> MemOSSearchResponse | None:
        """Search memories"""
        # Validate required parameters
        self._validate_required_params(query=query, user_id=user_id)

        url = f"{self.base_url}/search/memory"
        payload = {
            "query": query,
            "user_id": user_id,
            "conversation_id": conversation_id,
            "memory_limit_number": memory_limit_number,
            "include_preference": include_preference,
            "knowledgebase_ids": knowledgebase_ids,
            "filter": filter,
            "preference_limit_number": preference_limit_number,
            "tool_memory_limit_number": tool_memory_limit_number,
            "source": source,
            "include_tool_memory": include_tool_memory,
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

    def get_memory(self, user_id: str, include_preference: str) -> MemOSGetMemoryResponse | None:
        """get memories"""
        # Validate required parameters
        self._validate_required_params(include_preference=include_preference, user_id=user_id)

        url = f"{self.base_url}/get/memory"
        payload = {
            "include_preference": include_preference,
            "user_id": user_id,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSGetMemoryResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to get memory (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def create_knowledgebase(
        self, knowledgebase_name: str, knowledgebase_description: str
    ) -> MemOSCreateKnowledgebaseResponse | None:
        """
        Create knowledgebase
        """
        # Validate required parameters
        self._validate_required_params(
            knowledgebase_name=knowledgebase_name,
            knowledgebase_description=knowledgebase_description,
        )

        url = f"{self.base_url}/create/knowledgebase"
        payload = {
            "knowledgebase_name": knowledgebase_name,
            "knowledgebase_description": knowledgebase_description,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSCreateKnowledgebaseResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to create knowledgebase (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def delete_knowledgebase(
        self, knowledgebase_id: str
    ) -> MemOSDeleteKnowledgebaseResponse | None:
        """
        Delete knowledgebase
        """
        # Validate required parameters
        self._validate_required_params(knowledgebase_id=knowledgebase_id)

        url = f"{self.base_url}/delete/knowledgebase"
        payload = {
            "knowledgebase_id": knowledgebase_id,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSDeleteKnowledgebaseResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to delete knowledgebase (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def add_knowledgebase_file_json(
        self, knowledgebase_id: str, file: list[dict[str, Any]]
    ) -> MemOSAddKnowledgebaseFileResponse | None:
        """
        add knowledgebase-file from json
        """
        # Validate required parameters
        self._validate_required_params(knowledgebase_id=knowledgebase_id, file=file)

        url = f"{self.base_url}/add/knowledgebase-file"
        payload = {
            "knowledgebase_id": knowledgebase_id,
            "file": file,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSAddKnowledgebaseFileResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to add knowledgebase-file json (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def add_knowledgebase_file_form(
        self, knowledgebase_id: str, files: list[str]
    ) -> MemOSAddKnowledgebaseFileResponse | None:
        """
        add knowledgebase-file from form
        """
        # Validate required parameters
        self._validate_required_params(knowledgebase_id=knowledgebase_id, files=files)

        def build_file_form_param(file_path):
            """
            form-Automatically generate the structure required for the `files` parameter in requests based on the local file path
            """
            if not os.path.isfile(file_path):
                logger.warning(f"File {file_path} does not exist")
                return None
            filename = os.path.basename(file_path)

            mime_type, _ = mimetypes.guess_type(file_path)
            if mime_type is None:
                mime_type = "application/octet-stream"
            return ("file", (filename, open(file_path, "rb"), mime_type))

        files_data = []
        for file_path in files:
            file_data = build_file_form_param(file_path)
            if file_data:
                files_data.append(file_data)
        url = f"{self.base_url}/add/knowledgebase-file"
        payload = {
            "knowledgebase_id": knowledgebase_id,
        }
        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url,
                    data=json.dumps(payload),
                    headers=self.headers,
                    timeout=30,
                    files=files_data,
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSAddKnowledgebaseFileResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to add knowledgebase-file form (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def delete_knowledgebase_file(
        self, file_ids: list[str]
    ) -> MemOSDeleteKnowledgebaseResponse | None:
        """
        delete knowledgebase-file
        """
        # Validate required parameters
        self._validate_required_params(file_ids=file_ids)

        url = f"{self.base_url}/delete/knowledgebase-file"
        payload = {
            "file_ids": file_ids,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSDeleteKnowledgebaseResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to delete knowledgebase-file (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def get_knowledgebase_file(
        self, file_ids: list[str]
    ) -> MemOSGetKnowledgebaseFileResponse | None:
        """
        get knowledgebase-file
        """
        # Validate required parameters
        self._validate_required_params(file_ids=file_ids)

        url = f"{self.base_url}/get/knowledgebase-file"
        payload = {
            "file_ids": file_ids,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSGetKnowledgebaseFileResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to get knowledgebase-file (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def get_task_status(self, task_id: str) -> MemOSGetTaskStatusResponse | None:
        """
        get task status
        """
        # Validate required parameters
        self._validate_required_params(task_id=task_id)

        url = f"{self.base_url}/get/status"
        payload = {
            "task_id": task_id,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSGetTaskStatusResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to get task status (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def add_feedback(
        self,
        user_id: str,
        conversation_id: str,
        feedback_content: str,
        agent_id: str | None = None,
        app_id: str | None = None,
        feedback_time: str | None = None,
        allow_public: bool = False,
        allow_knowledgebase_ids: list[str] | None = None,
    ) -> MemOSAddFeedBackResponse | None:
        """Add feedback"""
        # Validate required parameters
        self._validate_required_params(
            feedback_content=feedback_content, user_id=user_id, conversation_id=conversation_id
        )

        url = f"{self.base_url}/add/feedback"
        payload = {
            "feedback_content": feedback_content,
            "user_id": user_id,
            "conversation_id": conversation_id,
            "agent_id": agent_id,
            "app_id": app_id,
            "feedback_time": feedback_time,
            "allow_public": allow_public,
            "allow_knowledgebase_ids": allow_knowledgebase_ids,
        }
        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSAddFeedBackResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to add feedback (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def delete_memory(
        self, user_ids: list[str], memory_ids: list[str]
    ) -> MemOSDeleteMemoryResponse | None:
        """delete_memory memories"""
        # Validate required parameters
        self._validate_required_params(user_ids=user_ids, memory_ids=memory_ids)

        url = f"{self.base_url}/delete/memory"
        payload = {
            "user_ids": user_ids,
            "memory_ids": memory_ids,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSDeleteMemoryResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to delete memory (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise
