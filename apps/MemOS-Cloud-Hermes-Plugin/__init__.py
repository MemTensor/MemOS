"""MemOS memory plugin for Hermes.

Server-side memory extraction and semantic search via MemOS Platform.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Dict, List

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

logger = logging.getLogger(__name__)

SOURCE_HERMES_AGENT = "Hermes Agent"


def _load_config() -> dict:
    from hermes_constants import get_hermes_home

    config = {
        "api_key": os.environ.get("MEMOS_API_KEY", ""),
        "user_id": os.environ.get("MEMOS_USER_ID", "hermes_user"),
        "knowledgebase": None,
        "allowedAgents": None,
        "multiAgentMode": False,
    }

    config_path = get_hermes_home() / "memos.json"
    if config_path.exists():
        try:
            file_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            config.update({k: v for k, v in file_cfg.items() if v is not None and v != ""})
        except Exception:
            pass

    return config


SEARCH_SCHEMA = {
    "name": "memos_search",
    "description": "Search user's memories using MemOS Platform.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for in memories."},
        },
        "required": ["query"],
    },
}

ADD_MESSAGE_SCHEMA = {
    "name": "memos_add_message",
    "description": "Explicitly store a fact or message into MemOS memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "The fact or message to store."},
        },
        "required": ["content"],
    },
}


class MemosMemoryProvider(MemoryProvider):
    """MemOS Platform memory provider."""

    def __init__(self):
        self._config = None
        self._client = None
        self._client_lock = threading.Lock()
        self._api_key = ""
        self._user_id = "hermes_user"
        self._agent_id = ""
        self._session_id = ""
        self._sync_thread = None
        self._allowed_agents = None
        self._multi_agent_mode = False
        self._knowledgebase = None

    @property
    def name(self) -> str:
        return "memos"

    def is_available(self) -> bool:
        cfg = _load_config()
        return bool(cfg.get("api_key"))

    def save_config(self, values: dict, hermes_home: str) -> None:
        from pathlib import Path

        config_path = Path(hermes_home) / "memos.json"
        existing = {}
        if config_path.exists():
            try:
                existing = json.loads(config_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        existing.update(values)
        config_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False))

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "api_key",
                "description": "MemOS API key",
                "secret": True,
                "required": True,
                "env_var": "MEMOS_API_KEY",
                "url": "https://memos-dashboard.openmem.net/cn/apikeys/",
            },
            {
                "key": "user_id",
                "description": "MemOS user ID",
                "default": "hermes_user",
            },
            {
                "key": "knowledgebase",
                "description": (
                    "Knowledgebase ID or list of IDs for searching. "
                    "Optional, for example 'kb-123' or ['kb-123', 'kb-456']."
                ),
                "required": False,
            },
            {
                "key": "allowedAgents",
                "type": "list",
                "description": (
                    "List of agent IDs allowed to use memory. Optional. "
                    "If empty, all agents are allowed."
                ),
                "required": False,
            },
            {
                "key": "multiAgentMode",
                "description": "Enable multi-agent memory isolation.",
                "required": False,
                "default": False,
            },
        ]

    def _get_client(self):
        with self._client_lock:
            if self._client is not None:
                return self._client
            try:
                from memos.api.client import MemOSClient
            except ImportError as exc:
                raise RuntimeError("MemoryOS package not installed. Run: pip install MemoryOS") from exc

            self._client = MemOSClient(api_key=self._api_key)
            return self._client

    @staticmethod
    def _parse_list_or_str(val):
        if not val:
            return None
        if isinstance(val, str):
            try:
                parsed = json.loads(val)
                return parsed if isinstance(parsed, list) else [val]
            except json.JSONDecodeError:
                return [val]
        return val if isinstance(val, list) else [val]

    def initialize(self, session_id: str, **kwargs) -> None:
        self._config = _load_config()
        self._api_key = self._config.get("api_key", "")
        self._user_id = kwargs.get("user_id") or self._config.get("user_id", "hermes_user")
        self._agent_id = kwargs.get("agent_id") or kwargs.get("agent_identity", "hermes")
        self._session_id = session_id
        self._knowledgebase = self._parse_list_or_str(self._config.get("knowledgebase"))
        self._allowed_agents = self._parse_list_or_str(self._config.get("allowedAgents"))

        multi_agent = self._config.get("multiAgentMode", False)
        if isinstance(multi_agent, str):
            self._multi_agent_mode = multi_agent.lower() in ("true", "1", "yes", "y", "t")
        else:
            self._multi_agent_mode = bool(multi_agent)

    def _is_memory_enabled(self) -> bool:
        if not self._allowed_agents:
            return True
        return self._agent_id in self._allowed_agents

    def system_prompt_block(self) -> str:
        if not self._is_memory_enabled():
            return ""
        return (
            "# MemOS Memory\n"
            f"Active. User: {self._user_id}.\n"
            "Use memos_search to find memories, and memos_add_message to store facts."
        )

    def _build_search_filter(self) -> dict | None:
        agent_id = self._agent_id if self._multi_agent_mode else None
        if agent_id:
            return {"user": {"and": [{"agent_id": agent_id}]}}
        return None

    @staticmethod
    def _response_data(res: Any) -> dict | None:
        if res is None:
            return None
        if hasattr(res, "model_dump"):
            res = res.model_dump()
        elif hasattr(res, "dict"):
            res = res.dict()

        if not isinstance(res, dict) or res.get("code") != 0 or "data" not in res:
            return None
        return res["data"]

    @staticmethod
    def _memory_results_from_data(data: dict | None) -> list[str]:
        if data is None:
            return []

        results: list[str] = []
        if isinstance(data.get("memory_detail_list"), list):
            for memory in data["memory_detail_list"]:
                if memory.get("memory_value"):
                    results.append(memory["memory_value"])

        if isinstance(data.get("preference_detail_list"), list):
            prefs = [p["preference"] for p in data["preference_detail_list"] if p.get("preference")]
            if len(prefs) == 1:
                results.append(f"Preference: {prefs[0]}")
            elif prefs:
                results.append("Preferences:\n  - " + "\n  - ".join(prefs))

        return results

    @classmethod
    def _memory_results_from_response(cls, res: Any) -> list[str]:
        return cls._memory_results_from_data(cls._response_data(res))

    def _search_kwargs(self) -> dict:
        kwargs = {}
        if self._knowledgebase:
            kwargs["knowledgebase_ids"] = (
                self._knowledgebase if isinstance(self._knowledgebase, list) else [self._knowledgebase]
            )
        search_filter = self._build_search_filter()
        if search_filter:
            kwargs["filter"] = search_filter
        return kwargs

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._is_memory_enabled() or len(query) < 3:
            return ""
        try:
            client = self._get_client()
            sid = session_id or self._session_id
            res = client.search_memory(
                query=query,
                user_id=self._user_id,
                conversation_id=sid,
                source=SOURCE_HERMES_AGENT,
                **self._search_kwargs(),
            )
            memories = self._memory_results_from_response(res)
            if memories:
                result = "\n".join(f"- {memory}" for memory in memories)
                return f"## MemOS Memory\n{result}"
        except Exception as exc:
            logger.debug("MemOS prefetch failed: %s", exc, exc_info=True)

        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        pass

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        if not self._is_memory_enabled():
            return

        def _sync():
            try:
                client = self._get_client()
                sid = session_id or self._session_id
                messages = [
                    {"role": "user", "content": user_content},
                    {"role": "assistant", "content": assistant_content},
                ]
                info = {"source": SOURCE_HERMES_AGENT, "agent_id": self._agent_id}
                client.add_message(
                    messages=messages,
                    user_id=self._user_id,
                    conversation_id=sid,
                    agent_id=self._agent_id,
                    source=SOURCE_HERMES_AGENT,
                    info=info,
                )
            except Exception as exc:
                logger.warning("MemOS sync failed: %s", exc, exc_info=True)

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)

        self._sync_thread = threading.Thread(target=_sync, daemon=True, name="memos-sync")
        self._sync_thread.start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SEARCH_SCHEMA, ADD_MESSAGE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: dict, **kwargs) -> str:
        if not self._is_memory_enabled():
            return tool_error("Memory is disabled for this agent.")

        try:
            client = self._get_client()
        except Exception as exc:
            return tool_error(str(exc))

        sid = kwargs.get("session_id") or self._session_id

        if tool_name == "memos_search":
            query = args.get("query", "")
            if not query:
                return tool_error("Missing required parameter: query")
            if len(query) < 3:
                return json.dumps({"result": "No relevant memories found."}, ensure_ascii=False)
            try:
                res = client.search_memory(
                    query=query,
                    user_id=self._user_id,
                    conversation_id=sid,
                    source=SOURCE_HERMES_AGENT,
                    **self._search_kwargs(),
                )
                data = self._response_data(res)
                if data is None:
                    return json.dumps(
                        {"result": "No relevant memories found or API error."},
                        ensure_ascii=False,
                    )
                results = self._memory_results_from_data(data)
                if not results:
                    return json.dumps({"result": "No relevant memories found."}, ensure_ascii=False)
                return json.dumps({"results": results, "count": len(results)}, ensure_ascii=False)
            except Exception as exc:
                return tool_error(f"Search failed: {exc}")

        if tool_name == "memos_add_message":
            content = args.get("content", "")
            if not content:
                return tool_error("Missing required parameter: content")
            try:
                messages = [{"role": "user", "content": content}]
                info = {"source": SOURCE_HERMES_AGENT, "agent_id": self._agent_id}
                res = client.add_message(
                    messages=messages,
                    user_id=self._user_id,
                    conversation_id=sid,
                    agent_id=self._agent_id,
                    source=SOURCE_HERMES_AGENT,
                    info=info,
                )
                if res is None:
                    return json.dumps({"error": "API error: No response"}, ensure_ascii=False)
                if hasattr(res, "model_dump"):
                    res = res.model_dump()
                elif hasattr(res, "dict"):
                    res = res.dict()

                if res.get("code") == 0:
                    return json.dumps({"result": "Fact stored successfully."}, ensure_ascii=False)
                return json.dumps(
                    {"error": f"API error: {res.get('message', 'Unknown error')}"},
                    ensure_ascii=False,
                )
            except Exception as exc:
                return tool_error(f"Failed to store: {exc}")

        return tool_error(f"Unknown tool: {tool_name}")

    def shutdown(self) -> None:
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        with self._client_lock:
            self._client = None


def register(ctx) -> None:
    """Register MemOS as a Hermes memory provider when the context supports it."""
    if not hasattr(ctx, "register_memory_provider"):
        logger.debug("MemOS memory provider registration skipped: unsupported plugin context")
        return
    ctx.register_memory_provider(MemosMemoryProvider())
