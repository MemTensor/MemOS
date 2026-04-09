"""Async HTTP client for MemOS Cloud API."""
import asyncio
import logging

from typing import Any

import aiohttp


logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://memos.memtensor.cn/api/openmem/v1"
_DEFAULT_TIMEOUT = 8.0
_DEFAULT_RETRIES = 1


class MemOSClient:
    """Async client for MemOS Cloud API.

    Handles authentication, retries, and graceful degradation for
    the two core endpoints: /search/memory and /add/message.
    """

    def __init__(
        self,
        base_url: str = _DEFAULT_BASE_URL,
        api_key: str = "",
        timeout: float = _DEFAULT_TIMEOUT,
        retries: int = _DEFAULT_RETRIES,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.retries = retries
        self._session: aiohttp.ClientSession | None = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Token {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=aiohttp.ClientTimeout(total=self.timeout),
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def _post(
        self,
        path: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """POST with retry. Returns parsed JSON or None on failure."""
        url = f"{self.base_url}{path}"
        last_err: Exception | None = None

        for attempt in range(1 + self.retries):
            try:
                session = await self._ensure_session()
                async with session.post(url, json=payload) as resp:
                    if resp.status == 200:
                        return await resp.json()
                    body = await resp.text()
                    logger.warning(
                        "MemOS API %s returned %s: %s",
                        path,
                        resp.status,
                        body[:300],
                    )
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                last_err = exc
                logger.warning(
                    "MemOS API %s attempt %d failed: %s",
                    path,
                    attempt + 1,
                    exc,
                )
            if attempt < self.retries:
                await asyncio.sleep(0.5 * (attempt + 1))

        logger.error("MemOS API %s exhausted retries: %s", path, last_err)
        return None

    # ------------------------------------------------------------------ #
    # Search / Recall
    # ------------------------------------------------------------------ #

    async def search_memory(
        self,
        user_id: str,
        query: str,
        *,
        source: str = "copaw",
        conversation_id: str = "",
        memory_limit_number: int = 9,
        include_preference: bool = True,
        preference_limit_number: int = 6,
        include_tool_memory: bool = False,
        tool_memory_limit_number: int = 6,
        relativity: float = 0.45,
        knowledgebase_ids: list[str] | None = None,
        filter_obj: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Call POST /search/memory.

        Returns the ``data`` dict from MemOS response, or *None* on failure.
        """
        payload: dict[str, Any] = {
            "user_id": user_id,
            "query": query,
            "source": source,
            "memory_limit_number": memory_limit_number,
            "include_preference": include_preference,
            "preference_limit_number": preference_limit_number,
            "include_tool_memory": include_tool_memory,
            "tool_memory_limit_number": tool_memory_limit_number,
            "relativity": relativity,
        }
        if conversation_id:
            payload["conversation_id"] = conversation_id
        if knowledgebase_ids:
            payload["knowledgebase_ids"] = knowledgebase_ids
        if filter_obj:
            payload["filter"] = filter_obj

        result = await self._post("/search/memory", payload)
        if result is None:
            return None
        return result.get("data", result)

    # ------------------------------------------------------------------ #
    # Add / Store
    # ------------------------------------------------------------------ #

    async def add_message(
        self,
        user_id: str,
        messages: list[dict[str, str]],
        *,
        conversation_id: str = "",
        source: str = "copaw",
        agent_id: str = "",
        async_mode: bool = True,
        tags: list[str] | None = None,
    ) -> bool:
        """Call POST /add/message.

        Returns True on success, False on failure.
        """
        payload: dict[str, Any] = {
            "user_id": user_id,
            "messages": messages,
            "source": source,
            "async_mode": async_mode,
            "tags": tags or ["copaw"],
        }
        if conversation_id:
            payload["conversation_id"] = conversation_id
        if agent_id:
            payload["agent_id"] = agent_id

        result = await self._post("/add/message", payload)
        return result is not None

    # ------------------------------------------------------------------ #
    # Health check
    # ------------------------------------------------------------------ #

    async def ping(self) -> bool:
        """Lightweight connectivity check via a minimal search call.

        Returns True only for 2xx responses.  401/403 (bad key) and
        other client errors are treated as failures so that ``start()``
        does not falsely report a healthy connection.
        """
        try:
            session = await self._ensure_session()
            async with session.post(
                f"{self.base_url}/search/memory",
                json={"user_id": "_ping", "query": "ping"},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                return 200 <= resp.status < 300
        except Exception:
            return False
