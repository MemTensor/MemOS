# -*- coding: utf-8 -*-
"""MemOS Cloud memory manager for CoPaw agents.

Implements CoPaw's BaseMemoryManager interface, delegating long-term
memory search/add to MemOS Cloud while handling context compaction locally.
"""
import asyncio
import datetime
import logging
import os
from typing import TYPE_CHECKING, List, Optional

from agentscope.memory import InMemoryMemory
from agentscope.message import Msg, TextBlock
from agentscope.tool import ToolResponse

from copaw.agents.memory.base_memory_manager import BaseMemoryManager
from copaw.constant import EnvVarLoader

if TYPE_CHECKING:
    from copaw.config.config import AgentProfileConfig

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# Thin InMemoryMemory subclass with _long_term_memory attribute
# required by CoPawAgent.reply() for force_memory_search injection.
# ------------------------------------------------------------------ #


class MemOSInMemoryMemory(InMemoryMemory):
    """InMemoryMemory wrapper that carries a _long_term_memory slot."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._long_term_memory: str = ""


# ------------------------------------------------------------------ #
# Helper: format MemOS search results into readable text
# ------------------------------------------------------------------ #


def _format_search_results(data: dict) -> str:
    """Convert MemOS /search/memory response data into plain-text blocks."""
    parts: list[str] = []

    for item in data.get("memory_detail_list", []):
        ts = item.get("update_time") or item.get("create_time")
        date_str = ""
        if ts:
            try:
                date_str = datetime.datetime.fromtimestamp(
                    ts,
                    tz=datetime.timezone.utc,
                ).strftime("[%Y-%m-%d %H:%M] ")
            except (OSError, ValueError):
                pass
        value = (item.get("memory_value") or "")[:8000]
        rel = item.get("relativity", 0)
        parts.append(f"{date_str}{value} (score={rel:.2f})")

    for item in data.get("preference_detail_list", []):
        ptype = item.get("preference_type", "Preference")
        pref = item.get("preference", "")
        parts.append(f"[{ptype}] {pref}")

    return "\n---\n".join(parts) if parts else ""


# ------------------------------------------------------------------ #
# MemOSMemoryManager
# ------------------------------------------------------------------ #


class MemOSMemoryManager(BaseMemoryManager):
    """Memory manager backed by MemOS Cloud.

    Cloud-side operations:
      - memory_search  → POST /search/memory
      - add_message     → POST /add/message  (via summary_memory)

    Local operations (no external dependency):
      - compact_memory / compact_tool_result / check_context
        use the agent's chat model for in-process context management.

    Configuration is read from agent config ``running.memos_config``
    with environment-variable fallbacks:
      - MEMOS_API_KEY, MEMOS_BASE_URL, MEMOS_USER_ID
    """

    def __init__(self, working_dir: str, agent_id: str):
        super().__init__(working_dir=working_dir, agent_id=agent_id)
        self._client = None  # lazily created in start()
        self._in_memory: Optional[MemOSInMemoryMemory] = None
        self._pending_messages: list[dict] = []
        self._config_cache: Optional[dict] = None

    # ------------------------------------------------------------------ #
    # Config resolution
    # ------------------------------------------------------------------ #

    def _load_memos_config(self) -> dict:
        """Resolve MemOS config: agent config > env var > default."""
        if self._config_cache is not None:
            return self._config_cache

        # Try loading from agent config
        cfg = {}
        try:
            from copaw.config.config import load_agent_config

            ac = load_agent_config(self.agent_id)
            if hasattr(ac.running, "memos_config"):
                mc = ac.running.memos_config
                cfg = {
                    "base_url": mc.base_url,
                    "api_key": mc.api_key,
                    "user_id": mc.user_id,
                    "memory_limit_number": mc.memory_limit_number,
                    "include_preference": mc.include_preference,
                    "preference_limit_number": mc.preference_limit_number,
                    "relativity": mc.relativity,
                    "timeout": mc.timeout,
                    "conversation_id": mc.conversation_id,
                    "knowledgebase_ids": mc.knowledgebase_ids,
                    "async_mode": mc.async_mode,
                }
        except Exception as e:
            logger.debug("Could not load memos_config from agent config: %s", e)

        # Env-var fallbacks
        result = {
            "base_url": cfg.get("base_url")
            or EnvVarLoader.get_str(
                "MEMOS_BASE_URL",
                "https://memos.memtensor.cn/api/openmem/v1",
            ),
            "api_key": cfg.get("api_key")
            or EnvVarLoader.get_str("MEMOS_API_KEY", ""),
            "user_id": cfg.get("user_id")
            or EnvVarLoader.get_str("MEMOS_USER_ID", "copaw-user"),
            "memory_limit_number": cfg.get("memory_limit_number", 9),
            "include_preference": cfg.get("include_preference", True),
            "preference_limit_number": cfg.get("preference_limit_number", 6),
            "relativity": cfg.get("relativity", 0.45),
            "timeout": cfg.get("timeout", 8.0),
            "conversation_id": cfg.get("conversation_id", ""),
            "knowledgebase_ids": cfg.get("knowledgebase_ids", []),
            "async_mode": cfg.get("async_mode", True),
        }
        self._config_cache = result
        return result

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    async def start(self) -> None:
        """Initialise the MemOS HTTP client and verify connectivity."""
        # Lazy import to avoid top-level dependency on aiohttp
        # when the plugin is merely discovered but not activated.
        import importlib.util
        _spec = importlib.util.spec_from_file_location(
            "memos_client",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "memos_client.py",
            ),
        )
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        MemOSClient = _mod.MemOSClient

        cfg = self._load_memos_config()
        if not cfg["api_key"]:
            logger.warning(
                "MemOS API key not configured. Set MEMOS_API_KEY env var "
                "or add memos_config.api_key to agent config."
            )

        self._client = MemOSClient(
            base_url=cfg["base_url"],
            api_key=cfg["api_key"],
            timeout=cfg["timeout"],
        )

        masked_key = (
            cfg["api_key"][:5] + "***"
            if len(cfg["api_key"]) > 5
            else "***"
        )
        ok = await self._client.ping()
        if ok:
            logger.info(
                "MemOS Cloud connected: %s (key=%s)",
                cfg["base_url"],
                masked_key,
            )
        else:
            logger.warning(
                "MemOS Cloud unreachable at %s — memory search will "
                "degrade gracefully.",
                cfg["base_url"],
            )

    async def close(self) -> bool:
        """Flush pending messages and close the HTTP session."""
        if self._pending_messages and self._client:
            cfg = self._load_memos_config()
            await self._client.add_message(
                user_id=cfg["user_id"],
                messages=self._pending_messages,
                conversation_id=cfg["conversation_id"],
                agent_id=self.agent_id,
                async_mode=cfg["async_mode"],
            )
            self._pending_messages.clear()

        if self._client:
            await self._client.close()
        return True

    # ------------------------------------------------------------------ #
    # Memory search  (core MemOS feature)
    # ------------------------------------------------------------------ #

    async def memory_search(
        self,
        query: str,
        max_results: int = 5,
        min_score: float = 0.1,
    ) -> ToolResponse:
        """Search MemOS Cloud for relevant memories."""
        if not self._client:
            return ToolResponse(
                content=[
                    TextBlock(
                        type="text",
                        text="MemOS client not initialized. "
                        "Check API key and base URL configuration.",
                    ),
                ],
            )

        cfg = self._load_memos_config()
        data = await self._client.search_memory(
            user_id=cfg["user_id"],
            query=query,
            memory_limit_number=max_results,
            include_preference=cfg["include_preference"],
            preference_limit_number=cfg["preference_limit_number"],
            relativity=max(min_score, cfg["relativity"]),
            conversation_id=cfg["conversation_id"],
            knowledgebase_ids=cfg["knowledgebase_ids"] or None,
        )

        if data is None:
            return ToolResponse(
                content=[
                    TextBlock(
                        type="text",
                        text="MemOS Cloud search returned no results "
                        "(API may be unreachable).",
                    ),
                ],
            )

        text = _format_search_results(data)
        if not text:
            return ToolResponse(
                content=[
                    TextBlock(
                        type="text",
                        text="No relevant memories found.",
                    ),
                ],
            )

        return ToolResponse(
            content=[TextBlock(type="text", text=text)],
        )

    # ------------------------------------------------------------------ #
    # Context compaction  (local, no cloud dependency)
    # ------------------------------------------------------------------ #

    async def compact_tool_result(self, **kwargs) -> None:
        """Truncate oversized tool outputs in-place."""
        messages: list = kwargs.get("messages", [])
        max_chars: int = kwargs.get("max_chars", 20000)
        for msg in messages:
            if hasattr(msg, "content") and isinstance(msg.content, str):
                if len(msg.content) > max_chars:
                    msg.content = (
                        msg.content[:max_chars]
                        + f"\n... [truncated, original {len(msg.content)} chars]"
                    )

    async def check_context(self, **kwargs) -> tuple:
        """Simple context-size check based on character count.

        Returns (messages_to_compact, remaining, is_valid).
        """
        messages: list = kwargs.get("messages", [])
        max_chars: int = kwargs.get("max_input_length", 120000)
        compact_ratio: float = kwargs.get("compact_ratio", 0.5)

        total = sum(
            len(getattr(m, "content", "") or "") for m in messages
        )
        if total <= max_chars:
            return [], messages, True

        # Keep the most recent messages within budget
        cut = max(1, int(len(messages) * compact_ratio))
        return messages[:cut], messages[cut:], False

    async def compact_memory(
        self,
        messages: list[Msg],
        previous_summary: str = "",
        extra_instruction: str = "",
        **kwargs,
    ) -> str:
        """Summarise old messages using the agent's chat model.

        Also queues the summary for async upload to MemOS Cloud.
        """
        if not messages:
            return previous_summary

        self._prepare_model_formatter()
        if self.chat_model is None:
            # Fallback: concatenate content
            lines = [
                f"{m.role}: {getattr(m, 'content', '')[:500]}"
                for m in messages[-20:]
            ]
            summary = "\n".join(lines)
        else:
            transcript = "\n".join(
                f"[{m.role}] {getattr(m, 'content', '')[:2000]}"
                for m in messages
            )
            prompt = (
                "Condense the following conversation into a concise summary "
                "that preserves all key facts, decisions, and action items. "
                "Keep it under 800 words.\n\n"
            )
            if previous_summary:
                prompt += f"Previous summary:\n{previous_summary}\n\n"
            if extra_instruction:
                prompt += f"Additional instruction: {extra_instruction}\n\n"
            prompt += f"Conversation:\n{transcript}"

            try:
                response = self.chat_model(
                    Msg(role="user", content=prompt),
                )
                summary = (
                    response.content
                    if hasattr(response, "content")
                    else str(response)
                )
            except Exception as e:
                logger.error("compact_memory LLM call failed: %s", e)
                summary = previous_summary or ""

        # Queue the summary for async upload to MemOS Cloud
        if summary and self._client:
            self._pending_messages.append(
                {"role": "assistant", "content": f"[summary] {summary}"}
            )

        return summary

    async def summary_memory(self, messages: list[Msg], **kwargs) -> str:
        """Summarise messages and upload to MemOS Cloud."""
        summary = await self.compact_memory(messages, **kwargs)

        # Immediately upload conversation + summary
        if self._client and messages:
            cfg = self._load_memos_config()
            conv_msgs = []
            for m in messages[-30:]:
                role = getattr(m, "role", "user")
                content = getattr(m, "content", "")
                if isinstance(content, str) and content.strip():
                    conv_msgs.append(
                        {"role": role, "content": content[:20000]}
                    )

            if conv_msgs:
                await self._client.add_message(
                    user_id=cfg["user_id"],
                    messages=conv_msgs,
                    conversation_id=cfg["conversation_id"],
                    agent_id=self.agent_id,
                    async_mode=cfg["async_mode"],
                )

        return summary

    # ------------------------------------------------------------------ #
    # InMemoryMemory bridge
    # ------------------------------------------------------------------ #

    def get_in_memory_memory(self, **kwargs) -> MemOSInMemoryMemory:
        """Return an InMemoryMemory with _long_term_memory support."""
        if self._in_memory is None:
            self._in_memory = MemOSInMemoryMemory()
        return self._in_memory

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _prepare_model_formatter(self) -> None:
        """Lazily initialize chat_model and formatter if not set."""
        if self.chat_model is None or self.formatter is None:
            try:
                from copaw.agents.model_factory import create_model_and_formatter

                self.chat_model, self.formatter = create_model_and_formatter(
                    self.agent_id,
                )
            except Exception as e:
                logger.warning("Failed to init chat model: %s", e)
