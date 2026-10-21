"""Prefix-cache-friendly chat message assembly (Issue #2524).

These tests pin down the invariants from the issue:
- The first message (stable system prompt) must stay byte-identical across turns
  within one conversation.
- Chat history sits inside the shared prefix (between the stable system message
  and the per-turn dynamic context).
- Per-turn retrieved memories, preferences, and the current time move into a
  separate system message that is placed immediately before the final user
  query so that the common prefix across requests can grow.
- A custom base_prompt that embeds `{memories}` keeps the legacy single-system
  shape (backward compatibility).
"""

from __future__ import annotations

import re

from typing import TYPE_CHECKING
from unittest.mock import MagicMock

from memos.api.handlers.chat_handler import ChatHandler


if TYPE_CHECKING:
    import pytest


def _make_handler(monkeypatch: pytest.MonkeyPatch) -> ChatHandler:
    """Construct a ChatHandler without going through its real __init__.

    The real __init__ validates dependencies and wires sub-handlers; the tests
    here only exercise the message-assembly helpers and inject fakes for
    `chat_llms` / `search_handler` as needed.
    """
    handler = ChatHandler.__new__(ChatHandler)
    handler.logger = MagicMock()
    handler.chat_llms = {}
    handler.playground_chat_llms = {}
    handler.search_handler = MagicMock()
    handler.add_handler = MagicMock()
    handler.online_bot = None
    handler.enable_mem_scheduler = False
    handler.dependencies = MagicMock()
    return handler


def _memory(mem_id: str, text: str) -> dict:
    return {
        "id": mem_id,
        "memory": text,
        "metadata": {"memory_type": "PersonalMemory", "updated_at": "2026-01-01T00:00:00"},
        "relativity": 0.9,
    }


class TestStableAndDynamicSplit:
    """INV-1 / INV-3 / INV-5: the handler can produce a stable system prompt
    plus a per-turn dynamic context string."""

    def test_stable_system_prompt_omits_current_time_and_memories(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)
        memories = [_memory("m-1", "User likes dim sum on weekends")]

        prompt_turn_1 = handler._build_stable_system_prompt(
            query="What should I eat?", base_prompt=None
        )
        prompt_turn_2 = handler._build_stable_system_prompt(
            query="How about tonight?", base_prompt=None
        )

        # INV-1: byte-identical across turns.
        assert prompt_turn_1 == prompt_turn_2
        # Dynamic data must not leak into the stable prompt.
        assert "User likes dim sum" not in prompt_turn_1
        # No current-minute timestamp substituted into the stable prompt.
        assert not re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", prompt_turn_1)
        # The placeholder itself must be gone — otherwise the model sees "{current_time}".
        assert "{current_time}" not in prompt_turn_1
        assert "{memories}" not in prompt_turn_1
        _ = memories  # explicit: memories not used while building stable prompt

    def test_dynamic_context_contains_time_memories_and_preferences(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)
        memories = [
            _memory("m-1", "User lives in Shanghai"),
            _memory("m-2", "User prefers short answers"),
        ]
        pref_string = "- answer in English"

        dynamic = handler._build_dynamic_context_message(
            memories=memories,
            pref_string=pref_string,
            lang="en",
        )

        assert dynamic is not None
        assert "User lives in Shanghai" in dynamic
        assert "User prefers short answers" in dynamic
        assert "- answer in English" in dynamic
        # Current time appears here, not in the stable prompt.
        assert re.search(r"\d{4}-\d{2}-\d{2}", dynamic)

    def test_dynamic_context_returns_none_when_nothing_dynamic(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)
        # No memories, no preferences — still, we may want to emit the current
        # time or nothing; the invariant is just "if everything is empty,
        # don't inject a message".
        dynamic = handler._build_dynamic_context_message(
            memories=[],
            pref_string=None,
            lang="en",
            include_time=False,
        )
        assert dynamic is None


class TestCacheableAssemblyShape:
    """INV-2 / INV-3: assembled message list has stable[0], history, dynamic, user."""

    def test_messages_place_history_before_dynamic_context(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)

        history = [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
        ]
        memories = [_memory("m-1", "User lives in Shanghai")]

        messages = handler._assemble_cacheable_messages(
            query="Where should I eat tonight?",
            history=history,
            memories=memories,
            pref_string="- short answers",
            base_prompt=None,
            lang="en",
        )

        # Stable system first.
        assert messages[0]["role"] == "system"
        assert "User lives in Shanghai" not in messages[0]["content"]

        # History sits inside the shared prefix.
        assert messages[1] == history[0]
        assert messages[2] == history[1]

        # Dynamic context is a user-role framing message right before the
        # user query (OCR round 2 feedback: mid-conversation ``system``
        # messages are not portable across provider APIs).
        assert messages[-2]["role"] == "user"
        assert messages[-2]["content"].startswith("[Context for this turn]\n")
        assert "User lives in Shanghai" in messages[-2]["content"]

        # Final message is the user turn.
        assert messages[-1] == {"role": "user", "content": "Where should I eat tonight?"}

    def test_shared_prefix_grows_across_turns(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Two consecutive turns must share stable + prior-history prefix."""
        handler = _make_handler(monkeypatch)

        turn1_history: list[dict] = []
        turn1 = handler._assemble_cacheable_messages(
            query="Hi",
            history=turn1_history,
            memories=[_memory("m-1", "User lives in Shanghai")],
            pref_string=None,
            base_prompt=None,
            lang="en",
        )

        # Second turn carries turn 1's exchange as history.
        turn2_history = [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
        ]
        turn2 = handler._assemble_cacheable_messages(
            query="Where should I eat tonight?",
            history=turn2_history,
            memories=[_memory("m-2", "User likes dim sum")],
            pref_string=None,
            base_prompt=None,
            lang="en",
        )

        # INV-1: stable system message is identical.
        assert turn1[0] == turn2[0]
        # INV-2: turn 1's exchange (positions 1..2 in turn 2) matches history.
        assert turn2[1] == turn2_history[0]
        assert turn2[2] == turn2_history[1]
        # Longest shared prefix spans at least the stable system.
        assert turn1[0]["content"] == turn2[0]["content"]

    def test_assemble_omits_dynamic_message_when_no_memories_or_prefs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)
        history = [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
        ]
        messages = handler._assemble_cacheable_messages(
            query="How are you?",
            history=history,
            memories=[],
            pref_string=None,
            base_prompt=None,
            lang="en",
            include_dynamic_time=False,
        )

        # Without dynamic payload: stable system + history + user. No extra turn.
        assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
        assert messages[-1] == {"role": "user", "content": "How are you?"}


class TestLegacyBasePromptCompat:
    """INV-4: a custom base_prompt that embeds `{memories}` keeps the single-
    system shape (no reorder)."""

    def test_custom_base_prompt_with_memories_placeholder_keeps_legacy_shape(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)

        history = [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
        ]
        memories = [_memory("m-1", "User likes blue")]
        base_prompt = "You are a tailor. User memories: {memories}"

        messages = handler._assemble_cacheable_messages(
            query="Suggest a jacket colour",
            history=history,
            memories=memories,
            pref_string=None,
            base_prompt=base_prompt,
            lang="en",
        )

        # Legacy shape: [system(stable+inline memories), *history, user]
        assert len(messages) == 1 + len(history) + 1
        assert messages[0]["role"] == "system"
        assert "User likes blue" in messages[0]["content"]
        assert "{memories}" not in messages[0]["content"]
        assert messages[1:-1] == history
        assert messages[-1] == {"role": "user", "content": "Suggest a jacket colour"}


class TestEnhanceEndpointSplit:
    """Playground path uses `_build_enhance_*`. Same invariants must hold."""

    def test_enhance_stable_prompt_omits_time_and_memories(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)
        stable = handler._build_enhance_stable_prompt(lang="en", tone="friendly", verbosity="mid")
        # No ISO date, no personal/outer memory text.
        assert not re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", stable)
        assert "PersonalMemory (ordered)" not in stable or "## PersonalMemory (ordered)" in stable
        # The {date} placeholder must be substituted away (either with empty or
        # with a sentinel pointing to the context message).
        assert "{date}" not in stable

    def test_enhance_dynamic_context_contains_time_and_memory_blocks(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = _make_handler(monkeypatch)
        memories = [_memory("m-1", "User lives in Shanghai")]
        dynamic = handler._build_enhance_dynamic_context(
            memories_list=memories, pref_string="- short answers", lang="en"
        )
        assert "User lives in Shanghai" in dynamic
        assert "- short answers" in dynamic
        assert re.search(r"\d{4}-\d{2}-\d{2}", dynamic)
