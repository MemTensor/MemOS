# ruff: noqa: N999
"""Automatic MemOS integration for Hermes runtimes that execute Python user plugins, such as CLI and Gateway flows."""

from __future__ import annotations

import json
import logging
import os
import threading

from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests


logger = logging.getLogger(__name__)


class MemosMCPClient:
    def __init__(self) -> None:
        self.url = os.getenv("MEMOS_MCP_URL", "http://127.0.0.1:8766/mcp")
        self.timeout = float(os.getenv("MEMOS_MCP_TIMEOUT", "5"))
        self.user_id = os.getenv("MEMOS_USER_ID", "").strip()
        self.cube_id = os.getenv("MEMOS_CUBE_ID", "").strip()
        self.top_k = int(os.getenv("MEMOS_RETRIEVAL_TOP_K", "5"))
        self._session = requests.Session()
        self._session.trust_env = False
        self._session_id = ""
        self._lock = threading.RLock()
        self._request_id = 1

    @staticmethod
    def _parse_sse(text: str) -> dict[str, Any]:
        for block in text.replace("\r\n", "\n").split("\n\n"):
            lines = block.splitlines()
            data_started = False
            data_parts: list[str] = []
            for line in lines:
                if line.startswith("data:"):
                    data_started = True
                    data_parts.append(line[5:].lstrip())
                elif data_started:
                    data_parts.append(line)
            if data_parts:
                try:
                    return json.loads("".join(data_parts))
                except json.JSONDecodeError:
                    continue
        return {}

    def _next_request_id(self) -> int:
        with self._lock:
            self._request_id += 1
            return self._request_id

    def _initialize(self) -> None:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_request_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "hermes-memos-memory", "version": "1.0.0"},
            },
        }
        response = self._session.post(
            self.url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        session_id = response.headers.get("Mcp-Session-Id", "")
        if not session_id:
            raise RuntimeError("MemOS MCP initialize returned no session ID")
        self._session_id = session_id

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        with self._lock:
            if not self._session_id:
                self._initialize()
            session_id = self._session_id

        payload = {
            "jsonrpc": "2.0",
            "id": self._next_request_id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        response = self._session.post(
            self.url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Mcp-Session-Id": session_id,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        data = self._parse_sse(response.content.decode("utf-8"))
        result = data.get("result", {})
        if result.get("isError"):
            content = result.get("content") or []
            message = (
                content[0].get("text", "MemOS MCP tool failed") if content else "unknown error"
            )
            raise RuntimeError(message)
        content = result.get("content") or []
        return content[0].get("text") if content else None

    def search_memories(self, query: str) -> list[str]:
        arguments: dict[str, Any] = {"query": query}
        if self.user_id:
            arguments["user_id"] = self.user_id
        if self.cube_id:
            arguments["cube_ids"] = [self.cube_id]
        raw = self._call_tool("search_memories", arguments)
        data = json.loads(raw) if isinstance(raw, str) else raw
        memories: list[str] = []
        if not isinstance(data, dict):
            return memories
        for buckets in data.values():
            if not isinstance(buckets, list):
                continue
            for bucket in buckets:
                if not isinstance(bucket, dict):
                    continue
                for item in bucket.get("memories", []):
                    if isinstance(item, dict) and item.get("memory"):
                        memories.append(str(item["memory"]))
                    elif isinstance(item, str):
                        memories.append(item)
                    if len(memories) >= self.top_k:
                        return memories
        return memories

    def add_turn(self, session_id: str, messages: list[dict[str, str]]) -> None:
        arguments: dict[str, Any] = {
            "messages": messages,
            "session_id": session_id,
        }
        if self.user_id:
            arguments["user_id"] = self.user_id
        if self.cube_id:
            arguments["cube_id"] = self.cube_id
        self._call_tool("add_memory", arguments)


_CLIENT = MemosMCPClient()
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="hermes-memos")
_SEEN_TURNS: set[str] = set()
_SEEN_ORDER: deque[str] = deque()
_SEEN_LOCK = threading.Lock()
_MAX_SEEN_TURNS = 2048


def _remember_turn(turn_key: str) -> bool:
    with _SEEN_LOCK:
        if turn_key in _SEEN_TURNS:
            return False
        _SEEN_TURNS.add(turn_key)
        _SEEN_ORDER.append(turn_key)
        while len(_SEEN_ORDER) > _MAX_SEEN_TURNS:
            _SEEN_TURNS.discard(_SEEN_ORDER.popleft())
        return True


def _on_pre_llm_call(
    user_message: str = "",
    session_id: str = "",
    **_: Any,
) -> dict[str, str] | None:
    query = user_message.strip()
    if not query:
        return None
    try:
        memories = _CLIENT.search_memories(query)
    except Exception as exc:
        logger.debug("MemOS retrieval skipped: %s", exc)
        return None
    if not memories:
        return None
    rendered = "\n".join(f"- {memory}" for memory in memories)
    return {"context": f"Relevant long-term memories from MemOS:\n{rendered}"}


def _submit_turn(
    session_id: str,
    turn_id: str,
    user_message: str,
    assistant_response: str,
) -> None:
    user_text = user_message.strip()
    assistant_text = assistant_response.strip()
    if not user_text or not assistant_text:
        return
    turn_key = (
        f"{session_id}:{turn_id}"
        if turn_id
        else f"{session_id}:{hash((user_text, assistant_text))}"
    )
    if not _remember_turn(turn_key):
        return
    try:
        _CLIENT.add_turn(
            session_id=session_id,
            messages=[
                {"role": "user", "content": user_text},
                {"role": "assistant", "content": assistant_text},
            ],
        )
    except Exception as exc:
        logger.warning("MemOS turn ingestion failed: %s", exc)


def _on_post_llm_call(
    session_id: str = "",
    turn_id: str = "",
    user_message: str = "",
    assistant_response: str = "",
    **_: Any,
) -> None:
    _EXECUTOR.submit(
        _submit_turn,
        session_id,
        turn_id,
        user_message,
        assistant_response,
    )


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
