import json
import mimetypes
import os

from collections.abc import Iterator
from typing import Any
from urllib.parse import quote

import requests

from memos.api.product_models import (
    MemOSAddFeedBackResponse,
    MemOSAddKnowledgebaseFileResponse,
    MemOSAddResponse,
    MemOSChatResponse,
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

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        is_global: str | bool = "false",
    ):
        # Priority:
        # 1. base_url argument
        # 2. MEMOS_BASE_URL environment variable (direct URL)
        # 3. MEMOS_IS_GLOBAL environment variable (True/False toggle)
        arg_is_global = str(is_global).lower() in ("true", "1", "yes")
        memos_is_global = os.getenv("MEMOS_IS_GLOBAL", "false").lower() in ("true", "1", "yes")
        final_is_global = arg_is_global or memos_is_global
        default_url = (
            "https://api.memt.ai/platform/api/openmem/v1"
            if final_is_global
            else "https://memos.memtensor.cn/api/openmem/v1"
        )

        self.base_url = base_url or os.getenv("MEMOS_BASE_URL") or default_url

        api_key = api_key or os.getenv("MEMOS_API_KEY")

        if not api_key:
            raise ValueError("MemOS API key is required")
        self.api_key = api_key
        self.headers = {"Content-Type": "application/json", "Authorization": f"Token {api_key}"}

    def _validate_required_params(self, **params):
        """Validate required parameters - if passed, they must not be empty"""
        for param_name, param_value in params.items():
            if not param_value:
                raise ValueError(f"{param_name} is required")

    def _validate_profile_subject(self, user_id: str | None, agent_id: str | None) -> None:
        if bool(user_id) == bool(agent_id):
            raise ValueError("exactly one of user_id or agent_id is required")

    @staticmethod
    def _normalize_task_status_response(
        response_data: dict[str, Any], task_id: str
    ) -> dict[str, Any]:
        data = response_data.get("data")
        if not (isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict)):
            return response_data

        normalized_data = data[0].copy()
        normalized_data.setdefault("task_id", task_id)
        return {**response_data, "data": normalized_data}

    def _post_json_dict(
        self, endpoint: str, payload: dict[str, Any], operation: str
    ) -> dict[str, Any] | None:
        url = f"{self.base_url}/{endpoint}"
        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url, data=json.dumps(payload), headers=self.headers, timeout=30
                )
                response.raise_for_status()
                return response.json()
            except Exception as e:
                logger.error(
                    "Failed to %s (retry %s/%s): %s",
                    operation,
                    retry + 1,
                    MAX_RETRY_COUNT,
                    e,
                )
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def get_message(
        self,
        user_id: str,
        conversation_id: str | None = None,
        conversation_limit_number: int | None = None,
        message_limit_number: int | None = None,
        source: str | None = None,
    ) -> MemOSGetMessagesResponse | None:
        """Get message"""
        # Validate required parameters
        self._validate_required_params(user_id=user_id, conversation_id=conversation_id)

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
        user_id: str | list[str] | None = None,
        conversation_id: str | None = None,
        info: dict[str, Any] | None = None,
        source: str | None = None,
        app_id: str | None = None,
        agent_id: str | list[str] | None = None,
        async_mode: bool = True,
        tags: list[str] | None = None,
        allow_public: bool = False,
        allow_knowledgebase_ids: list[str] | None = None,
        allow_memory_view: list[str] | None = None,
    ) -> MemOSAddResponse | None:
        """Add message"""
        # Validate required parameters
        self._validate_required_params(messages=messages)
        if not user_id and not agent_id:
            raise ValueError("user_id or agent_id is required")

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
            "allow_memory_view": allow_memory_view,
            "tags": tags,
            "async_mode": async_mode,
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
        user_id: str | None = None,
        conversation_id: str | None = None,
        agent_id: str | None = None,
        memory_limit_number: int = 6,
        include_preference: bool = True,
        knowledgebase_ids: list[str] | None = None,
        filter: dict[str, Any] | None = None,
        source: str | None = None,
        include_tool_memory: bool = False,
        preference_limit_number: int = 6,
        tool_memory_limit_number: int = 6,
        relativity: float | None = None,
        include_skill: bool = False,
        skill_limit_number: int = 6,
        include_memory_view: list[str] | None = None,
        context_format: str = "memory",
    ) -> MemOSSearchResponse | None:
        """Search memories"""
        # Validate required parameters
        self._validate_required_params(query=query)
        self._validate_profile_subject(user_id, agent_id)

        url = f"{self.base_url}/search/memory"
        payload = {
            "query": query,
            "user_id": user_id,
            "conversation_id": conversation_id,
            "agent_id": agent_id,
            "memory_limit_number": memory_limit_number,
            "include_preference": include_preference,
            "knowledgebase_ids": knowledgebase_ids,
            "filter": filter,
            "preference_limit_number": preference_limit_number,
            "tool_memory_limit_number": tool_memory_limit_number,
            "relativity": relativity,
            "include_skill": include_skill,
            "skill_limit_number": skill_limit_number,
            "include_memory_view": include_memory_view,
            "context_format": context_format,
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

    def get_memory(
        self,
        user_id: str | None = None,
        include_preference: bool = True,
        page: int = 1,
        size: int = 10,
        agent_id: str | None = None,
        include_tool_memory: bool = True,
        include_memory_view: list[str] | None = None,
        filter: dict[str, Any] | None = None,
    ) -> MemOSGetMemoryResponse | None:
        """get memories"""
        # Validate required parameters
        self._validate_profile_subject(user_id, agent_id)
        if size > 50:
            raise ValueError("size must be less than or equal to 50")

        url = f"{self.base_url}/get/memory"
        payload = {
            "include_preference": include_preference,
            "user_id": user_id,
            "agent_id": agent_id,
            "include_tool_memory": include_tool_memory,
            "include_memory_view": include_memory_view,
            "filter": filter,
            "page": page,
            "size": size,
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

    @staticmethod
    def _iter_sse_data(response: requests.Response) -> Iterator[str]:
        """Yield decoded data payloads from a Server-Sent Events response."""
        try:
            for line in response.iter_lines(decode_unicode=True):
                if isinstance(line, bytes):
                    line = line.decode("utf-8")
                if not line or not line.startswith("data:"):
                    continue
                yield line.removeprefix("data:").lstrip()
        finally:
            response.close()

    def get_memory_by_id(self, memid: str) -> dict[str, Any] | None:
        """Get one memory detail by its memory ID."""
        self._validate_required_params(memid=memid)

        url = f"{self.base_url}/get/memory/{quote(memid, safe='')}"
        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.get(url, headers=self.headers, timeout=30)
                response.raise_for_status()
                return response.json()
            except Exception as e:
                logger.error(
                    "Failed to get memory by ID (retry %s/%s): %s",
                    retry + 1,
                    MAX_RETRY_COUNT,
                    e,
                )
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def create_knowledgebase(
        self, knowledgebase_name: str, knowledgebase_description: str | None = None
    ) -> MemOSCreateKnowledgebaseResponse | None:
        """
        Create knowledgebase
        """
        # Validate required parameters
        self._validate_required_params(knowledgebase_name=knowledgebase_name)

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
        self, knowledgebase_id: str, files: list[str], type: str | None = None
    ) -> MemOSAddKnowledgebaseFileResponse | None:
        """
        add knowledgebase-file from form
        """
        # Validate required parameters
        self._validate_required_params(knowledgebase_id=knowledgebase_id, files=files)

        def build_file_form_param(file_path: str):
            """
            form-Automatically generate the structure required for the `files` parameter in requests based on the local file path
            """
            if not os.path.isfile(file_path):
                logger.warning("File %s does not exist", file_path)
                return None
            filename = os.path.basename(file_path)

            mime_type, _ = mimetypes.guess_type(file_path)
            if mime_type is None:
                mime_type = "application/octet-stream"
            return ("file", (filename, open(file_path, "rb"), mime_type))

        def build_file_form_params() -> list:
            file_params = [
                file_param
                for file_path in files
                if (file_param := build_file_form_param(file_path)) is not None
            ]
            if not file_params:
                raise ValueError("files must contain at least one valid file path")
            return file_params

        url = f"{self.base_url}/add/knowledgebase-file"
        payload = {
            "knowledgebase_id": knowledgebase_id,
        }
        if type is not None:
            payload["type"] = type
        headers = {
            "Authorization": f"Token {self.api_key}",
        }
        for retry in range(MAX_RETRY_COUNT):
            file_params = []
            try:
                file_params = build_file_form_params()
                response = requests.post(
                    url,
                    params=payload,
                    headers=headers,
                    timeout=30,
                    files=file_params,
                )
                response.raise_for_status()
                response_data = response.json()

                return MemOSAddKnowledgebaseFileResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to add knowledgebase-file form (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise
            finally:
                for file_param in file_params:
                    file_param[1][1].close()

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
        self,
        file_ids: list[str] | None = None,
        knowledgebase_id: str | None = None,
        type: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> MemOSGetKnowledgebaseFileResponse | None:
        """
        get knowledgebase-file
        """
        # Validate required parameters
        if bool(file_ids) == bool(knowledgebase_id):
            raise ValueError("exactly one of file_ids or knowledgebase_id is required")

        url = f"{self.base_url}/get/knowledgebase-file"
        payload = {
            "file_ids": file_ids,
            "knowledgebase_id": knowledgebase_id,
            "type": type,
            "page": page,
            "page_size": page_size,
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
                response_data = self._normalize_task_status_response(response_data, task_id)

                return MemOSGetTaskStatusResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to get task status (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise

    def add_feedback(
        self,
        user_id: str,
        conversation_id: str | None = None,
        feedback_content: str | None = None,
        agent_id: str | None = None,
        app_id: str | None = None,
        feedback_time: str | None = None,
        allow_public: bool = False,
        allow_knowledgebase_ids: list[str] | None = None,
    ) -> MemOSAddFeedBackResponse | None:
        """Add feedback"""
        # Validate required parameters
        self._validate_required_params(feedback_content=feedback_content, user_id=user_id)

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
        self,
        user_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        filter: dict[str, Any] | None = None,
        memory_type: str | None = None,
    ) -> MemOSDeleteMemoryResponse | None:
        """delete_memory memories"""
        if user_id is None and user_ids:
            if len(user_ids) != 1 and not memory_ids:
                raise ValueError("current API supports a single user_id, not multiple user_ids")
            if not memory_ids:
                user_id = user_ids[0]

        delete_modes = [
            bool(memory_ids),
            bool(user_id),
            bool(agent_id),
            filter is not None,
        ]
        if sum(delete_modes) != 1:
            raise ValueError("exactly one delete condition is required")

        url = f"{self.base_url}/delete/memory"
        payload: dict[str, Any] = {}
        if memory_ids:
            payload["memory_ids"] = memory_ids
        if user_id:
            payload["user_id"] = user_id
        if agent_id:
            payload["agent_id"] = agent_id
        if filter is not None:
            payload["filter"] = filter
        if memory_type is not None:
            payload["memory_type"] = memory_type

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

    def update_memory(
        self,
        memory_id: str,
        content: str | None = None,
        title: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any] | None:
        """Update an existing memory."""
        self._validate_required_params(memory_id=memory_id)
        if not content and not title and not status:
            raise ValueError("content, title or status is required")

        payload = {
            "memory_id": memory_id,
            "content": content,
            "title": title,
            "status": status,
        }
        return self._post_json_dict("update/memory", payload, "update memory")

    def extract_memory(
        self,
        messages: list[dict[str, Any]],
        extraction_types: list[str] | None = None,
        model: str | None = None,
    ) -> dict[str, Any] | None:
        """Extract memory candidates from conversation messages."""
        self._validate_required_params(messages=messages)

        payload = {
            "messages": messages,
            "extraction_types": extraction_types,
            "model": model,
        }
        return self._post_json_dict("extract/memory", payload, "extract memory")

    def rerank(
        self,
        query: str,
        documents: list[str],
        model: str | None = None,
        top_n: int | None = None,
    ) -> dict[str, Any] | None:
        """Rerank documents for a query."""
        self._validate_required_params(query=query, documents=documents)
        if top_n is not None and top_n <= 0:
            raise ValueError("top_n must be greater than 0")

        payload = {
            "query": query,
            "documents": documents,
            "model": model,
            "top_n": top_n,
        }
        return self._post_json_dict("rerank", payload, "rerank documents")

    def bind_profile_template(self, bind_list: list[dict[str, Any]]) -> dict[str, Any] | None:
        """Bind profile templates to user or agent subjects."""
        self._validate_required_params(bind_list=bind_list)

        payload = {
            "bind_list": bind_list,
        }
        return self._post_json_dict("bind/profile_template", payload, "bind profile template")

    def edit_profile(
        self,
        profile_template_id: str,
        user_id: str | None = None,
        agent_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        remove_fields: list[str] | None = None,
    ) -> dict[str, Any] | None:
        """Edit a profile instance."""
        self._validate_required_params(profile_template_id=profile_template_id)
        self._validate_profile_subject(user_id, agent_id)
        if metadata is None and not remove_fields:
            raise ValueError("metadata or remove_fields is required")

        payload = {
            "user_id": user_id,
            "agent_id": agent_id,
            "profile_template_id": profile_template_id,
            "metadata": metadata,
            "remove_fields": remove_fields,
        }
        return self._post_json_dict("edit/profile", payload, "edit profile")

    def delete_profile(
        self,
        profile_template_id: str,
        user_id: str | None = None,
        agent_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Delete a profile instance."""
        self._validate_required_params(profile_template_id=profile_template_id)
        self._validate_profile_subject(user_id, agent_id)

        payload = {
            "user_id": user_id,
            "agent_id": agent_id,
            "profile_template_id": profile_template_id,
        }
        return self._post_json_dict("delete/profile", payload, "delete profile")

    def chat(
        self,
        user_id: str,
        conversation_id: str,
        query: str,
        internet_search: bool = False,
        force_stop: bool = False,
        use_mem_os_cube: bool = False,
        source: str | None = None,
        system_prompt: str | None = None,
        model_name: str | None = None,
        knowledgebase_ids: list[str] | None = None,
        filter: dict[str, Any] | None = None,
        add_message_on_answer: bool = True,
        app_id: str | None = None,
        agent_id: str | None = None,
        async_mode: bool = True,
        tags: list[str] | None = None,
        info: dict[str, Any] | None = None,
        allow_public: bool = False,
        allow_knowledgebase_ids: list[str] | None = None,
        max_tokens: int = 8192,
        temperature: float | None = 0.7,
        top_p: float | None = 0.95,
        include_preference: bool = True,
        preference_limit_number: int = 6,
        memory_limit_number: int = 6,
        stream: bool = False,
        include_tool_memory: bool = False,
        tool_memory_limit_number: int = 6,
        relativity: float | None = None,
    ) -> MemOSChatResponse | Iterator[str] | None:
        """chat"""
        # Validate required parameters
        self._validate_required_params(
            user_id=user_id, conversation_id=conversation_id, query=query
        )

        url = f"{self.base_url}/chat"
        payload = {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "query": query,
            "internet_search": internet_search,
            "force_stop": force_stop,
            "use_mem_os_cube": use_mem_os_cube,
            "source": source,
            "system_prompt": system_prompt,
            "model_name": model_name,
            "knowledgebase_ids": knowledgebase_ids,
            "filter": filter,
            "add_message_on_answer": add_message_on_answer,
            "app_id": app_id,
            "agent_id": agent_id,
            "async_mode": async_mode,
            "tags": tags,
            "info": info,
            "allow_public": allow_public,
            "allow_knowledgebase_ids": allow_knowledgebase_ids,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "include_preference": include_preference,
            "preference_limit_number": preference_limit_number,
            "memory_limit_number": memory_limit_number,
            "stream": stream,
            "include_tool_memory": include_tool_memory,
            "tool_memory_limit_number": tool_memory_limit_number,
            "relativity": relativity,
        }

        for retry in range(MAX_RETRY_COUNT):
            try:
                response = requests.post(
                    url,
                    data=json.dumps(payload),
                    headers=self.headers,
                    timeout=30,
                    stream=stream,
                )
                response.raise_for_status()
                if stream:
                    return self._iter_sse_data(response)
                response_data = response.json()

                return MemOSChatResponse(**response_data)
            except Exception as e:
                logger.error(f"Failed to chat (retry {retry + 1}/3): {e}")
                if retry == MAX_RETRY_COUNT - 1:
                    raise
