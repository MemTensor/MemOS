# -*- coding: utf-8 -*-
"""MemOS Cloud memory manager for CoPaw agents.

Extends ReMeLightMemoryManager — all local operations (context compaction,
token counting, tool result truncation, in-memory memory) are delegated
to the parent class unchanged.  Only two methods are overridden:

  - memory_search  → queries MemOS Cloud instead of local vector index
  - summary_memory → uploads conversation to MemOS Cloud after local summary

This ensures full compatibility with CoPaw's MemoryCompactionHook and
force_memory_search auto-recall mechanism.
"""
import datetime
import logging
import os
from typing import Optional

from agentscope.message import Msg, TextBlock
from agentscope.tool import ToolResponse

from copaw.agents.memory.reme_light_memory_manager import (
    ReMeLightMemoryManager,
)
from copaw.constant import EnvVarLoader

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# Helper: format MemOS search results into readable text
# ------------------------------------------------------------------ #


def _format_search_results(data: dict) -> str:
    """Convert MemOS /search/memory response into plain-text blocks."""
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


class MemOSMemoryManager(ReMeLightMemoryManager):
    """Memory manager that combines ReMeLight local ops with MemOS Cloud.

    Inherits all ReMeLight capabilities:
      - compact_memory / compact_tool_result / check_context (token-aware)
      - get_in_memory_memory (with as_token_counter support)
      - summary_memory (file-based with toolkit)

    Overrides cloud-bound operations:
      - memory_search  → POST /search/memory to MemOS Cloud
      - summary_memory → parent summary + POST /add/message to MemOS Cloud

    Configuration is read from ``running.memos_config`` in agent config,
    with env-var fallbacks: MEMOS_API_KEY, MEMOS_BASE_URL, MEMOS_USER_ID.
    """

    def __init__(self, working_dir: str, agent_id: str):
        super().__init__(working_dir=working_dir, agent_id=agent_id)
        self._memos_client = None
        self._memos_cfg: Optional[dict] = None

    # ------------------------------------------------------------------ #
    # Config resolution
    # ------------------------------------------------------------------ #

    def _load_memos_config(self) -> dict:
        """Resolve MemOS config: agent config > env var > default."""
        if self._memos_cfg is not None:
            return self._memos_cfg

        cfg: dict = {}
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
            logger.debug(
                "Could not load memos_config from agent config: %s", e,
            )

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
        self._memos_cfg = result
        return result

    # ------------------------------------------------------------------ #
    # Lifecycle  (extend parent)
    # ------------------------------------------------------------------ #

    async def start(self) -> None:
        """Start ReMeLight, then initialise the MemOS HTTP client."""
        # ReMeLight local memory first
        await super().start()

        # MemOS Cloud client
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

        mc = self._load_memos_config()
        if not mc["api_key"]:
            logger.warning(
                "MemOS API key not configured. Set MEMOS_API_KEY env var "
                "or add memos_config.api_key to agent config.",
            )

        self._memos_client = _mod.MemOSClient(
            base_url=mc["base_url"],
            api_key=mc["api_key"],
            timeout=mc["timeout"],
        )

        masked = mc["api_key"][:5] + "***" if len(mc["api_key"]) > 5 else "***"
        ok = await self._memos_client.ping()
        if ok:
            logger.info(
                "MemOS Cloud connected: %s (key=%s)", mc["base_url"], masked,
            )
        else:
            logger.warning(
                "MemOS Cloud unreachable at %s — will fall back to "
                "local ReMeLight search.",
                mc["base_url"],
            )

    async def close(self) -> bool:
        """Close MemOS client, then close ReMeLight."""
        if self._memos_client:
            await self._memos_client.close()
            self._memos_client = None
        return await super().close()

    # ------------------------------------------------------------------ #
    # memory_search  →  MemOS Cloud (fallback: ReMeLight local)
    # ------------------------------------------------------------------ #

    async def memory_search(
        self,
        query: str,
        max_results: int = 5,
        min_score: float = 0.1,
    ) -> ToolResponse:
        """Search MemOS Cloud; fall back to local ReMeLight on failure."""
        if not self._memos_client:
            return await super().memory_search(query, max_results, min_score)

        mc = self._load_memos_config()
        data = await self._memos_client.search_memory(
            user_id=mc["user_id"],
            query=query,
            memory_limit_number=max_results,
            include_preference=mc["include_preference"],
            preference_limit_number=mc["preference_limit_number"],
            relativity=max(min_score, mc["relativity"]),
            conversation_id=mc["conversation_id"],
            knowledgebase_ids=mc["knowledgebase_ids"] or None,
        )

        # Fallback to local search if cloud is unreachable
        if data is None:
            logger.warning(
                "MemOS Cloud search failed, falling back to local search.",
            )
            return await super().memory_search(query, max_results, min_score)

        text = _format_search_results(data)
        if not text:
            # Cloud returned empty — try local as supplement
            return await super().memory_search(query, max_results, min_score)

        return ToolResponse(
            content=[TextBlock(type="text", text=text)],
        )

    # ------------------------------------------------------------------ #
    # summary_memory  →  ReMeLight summary + upload to MemOS Cloud
    # ------------------------------------------------------------------ #

    async def summary_memory(self, messages: list[Msg], **kwargs) -> str:
        """Run ReMeLight summary, then upload conversation to MemOS Cloud."""
        # Delegate to parent for the actual summarisation
        summary = await super().summary_memory(messages, **kwargs)

        # Upload conversation to MemOS Cloud (best-effort)
        if self._memos_client and messages:
            mc = self._load_memos_config()
            conv_msgs = []
            for m in messages[-30:]:
                role = getattr(m, "role", "user")
                content = getattr(m, "content", "")
                if isinstance(content, str) and content.strip():
                    conv_msgs.append(
                        {"role": role, "content": content[:20000]},
                    )
            if conv_msgs:
                try:
                    await self._memos_client.add_message(
                        user_id=mc["user_id"],
                        messages=conv_msgs,
                        conversation_id=mc["conversation_id"],
                        agent_id=self.agent_id,
                        async_mode=mc["async_mode"],
                    )
                except Exception as e:
                    logger.warning(
                        "Failed to upload summary to MemOS Cloud: %s", e,
                    )

        return summary
