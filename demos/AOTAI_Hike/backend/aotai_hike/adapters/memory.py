from __future__ import annotations

import json

from dataclasses import dataclass
from typing import Any

import requests

from loguru import logger


@dataclass
class MemorySearchResult:
    snippets: list[str]


@dataclass(frozen=True)
class MemoryNamespace:
    @staticmethod
    def role_cube_id(*, user_id: str, role_id: str) -> str:
        return f"cube_{user_id}_{role_id}"

    @staticmethod
    def world_cube_id(*, user_id: str) -> str:
        return f"cube_{user_id}_world"


class MemOSMemoryClient:
    def __init__(
        self,
        *,
        base_url: str,
        timeout_s: float = 20.0,
        default_mode: str = "fine",
        default_top_k: int = 5,
    ):
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._default_mode = default_mode
        self._default_top_k = default_top_k

    def add_memory(
        self,
        *,
        user_id: str,
        cube_id: str,
        memory_content: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
        async_mode: str = "async",
        mode: str | None = None,
        info: dict[str, Any] | None = None,
        custom_tags: list[str] | None = None,
        chat_history: list[dict[str, Any]] | None = None,
        source: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "user_id": user_id,
            "writable_cube_ids": [cube_id],
            "mem_cube_id": cube_id,
            "async_mode": async_mode,
        }
        if session_id:
            payload["session_id"] = session_id
        if mode:
            payload["mode"] = mode
        if memory_content:
            payload["memory_content"] = memory_content
        if messages:
            payload["messages"] = messages
        if chat_history is not None:
            payload["chat_history"] = chat_history
        if info:
            payload["info"] = info
        if custom_tags:
            payload["custom_tags"] = custom_tags
        if source:
            payload["source"] = source
        self._post("/product/add", payload)

    def search_memory(
        self,
        *,
        user_id: str,
        cube_id: str,
        query: str,
        top_k: int | None = None,
        session_id: str | None = None,
    ) -> MemorySearchResult:
        payload: dict[str, Any] = {
            "user_id": user_id,
            "query": query,
            "top_k": top_k if top_k is not None else self._default_top_k,
            "readable_cube_ids": [cube_id],
            "mem_cube_id": cube_id,
        }
        if session_id:
            payload["session_id"] = session_id
        data = self._post("/product/search", payload)
        snippets: list[str] = []
        try:
            mem_data = (data or {}).get("data", {})
            for entry in mem_data.get("text_mem", []) or []:
                for mem in entry.get("memories", []) or []:
                    text = mem.get("memory")
                    if text:
                        snippets.append(text)
        except Exception:
            logger.exception("Failed to parse search response")
        return MemorySearchResult(snippets=snippets)

    def chat_complete(
        self,
        *,
        user_id: str,
        cube_id: str,
        query: str,
        system_prompt: str | None = None,
        history: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
        top_k: int | None = None,
        mode: str | None = None,
        add_message_on_answer: bool = False,
        model_name_or_path: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        safe_top_k = self._default_top_k if top_k is None else max(1, int(top_k))
        payload: dict[str, Any] = {
            "user_id": user_id,
            "query": query,
            "readable_cube_ids": [cube_id],
            "writable_cube_ids": [cube_id],
            "mem_cube_id": cube_id,
            "top_k": safe_top_k,
            "mode": mode or self._default_mode,
            "add_message_on_answer": add_message_on_answer,
        }
        if system_prompt:
            payload["system_prompt"] = system_prompt
        if history is not None:
            payload["history"] = history
        if session_id:
            payload["session_id"] = session_id
        if model_name_or_path:
            payload["model_name_or_path"] = model_name_or_path
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        data = self._post("/product/chat/complete", payload)
        return ((data or {}).get("data") or {}).get("response") or ""

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        logger.info("[MemOS] POST {} payload={}", url, json.dumps(payload, ensure_ascii=False))
        resp = requests.post(
            url,
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload),
            timeout=self._timeout_s,
        )
        if resp.status_code >= 400:
            logger.error("MemOS error {}: {}", resp.status_code, resp.text)
            resp.raise_for_status()
        try:
            post_results = resp.json()
            logger.info(
                "[MemOS] POST {} response={}", url, json.dumps(post_results, ensure_ascii=False)
            )
            return post_results
        except Exception:
            logger.error("Invalid MemOS response: {}", resp.text)


class MemoryAdapter:
    def add_event(self, *, user_id: str, session_id: str, content: str) -> None:
        raise NotImplementedError

    def search(
        self, *, user_id: str, session_id: str, query: str, top_k: int = 5
    ) -> MemorySearchResult:
        raise NotImplementedError


class InMemoryMemoryAdapter(MemoryAdapter):
    def __init__(self):
        self._items: list[tuple[str, str, str]] = []

    def add_event(self, *, user_id: str, session_id: str, content: str) -> None:
        self._items.append((user_id, session_id, content))

    def search(
        self, *, user_id: str, session_id: str, query: str, top_k: int = 5
    ) -> MemorySearchResult:
        snippets: list[str] = []
        for uid, sid, c in reversed(self._items):
            if uid == user_id and sid == session_id:
                snippets.append(c)
            if len(snippets) >= top_k:
                break
        return MemorySearchResult(snippets=list(reversed(snippets)))


class MemOSMemoryAdapter(MemoryAdapter):
    def __init__(self, client: MemOSMemoryClient):
        self._client = client

    def add_event(self, *, user_id: str, session_id: str, content: str) -> None:
        cube_id = MemoryNamespace.world_cube_id(user_id=user_id)
        self._client.add_memory(
            user_id=user_id,
            cube_id=cube_id,
            session_id=session_id,
            messages=[{"role": "user", "content": content}],
            async_mode="async",
            mode="fine",
            source="aotai_hike_world",
        )

    def search(
        self, *, user_id: str, session_id: str, query: str, top_k: int = 5
    ) -> MemorySearchResult:
        cube_id = MemoryNamespace.world_cube_id(user_id=user_id)
        return self._client.search_memory(
            user_id=user_id,
            cube_id=cube_id,
            query=query,
            top_k=top_k,
            session_id=session_id,
        )
