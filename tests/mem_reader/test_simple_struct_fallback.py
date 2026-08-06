"""Regression tests for issue #1493.

`POST /product/add` returned 200 + "Memory added successfully" but persisted no
memory items. Root cause: when the LLM response fails JSON parsing,
`SimpleStructMemReader._get_llm_response` is supposed to emit a fallback dict
with a single salvaged `UserMemory` item so the request still produces at least
one stored memory. However, the fallback used the key `"memory_list"`
(underscore) while every downstream consumer reads `"memory list"` (space),
making the fallback unreachable and leaving `_process_chat_data` returning an
empty list.

These tests pin the fallback contract and the end-to-end reader behavior so the
regression cannot reappear.
"""

import unittest

from unittest.mock import MagicMock, patch

from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.item import TextualMemoryItem


class TestSimpleStructFallbackKey(unittest.TestCase):
    """Pin the fallback contract: key must match what consumers read."""

    def setUp(self):
        self.config = MagicMock(spec=SimpleStructMemReaderConfig)
        self.config.llm = MagicMock()
        self.config.general_llm = None
        self.config.embedder = MagicMock()
        self.config.chunker = MagicMock()
        self.config.remove_prompt_example = MagicMock()

        with (
            patch.object(LLMFactory, "from_config", return_value=MagicMock()),
            patch.object(EmbedderFactory, "from_config", return_value=MagicMock()),
            patch.object(ChunkerFactory, "from_config", return_value=MagicMock()),
        ):
            self.reader = SimpleStructMemReader(self.config)

        self.reader.llm = MagicMock()
        self.reader.general_llm = self.reader.llm
        self.reader.embedder = MagicMock()
        self.reader.embedder.embed = MagicMock(return_value=[[0.0] * 4])
        self.reader.chunker = MagicMock()

    def test_get_llm_response_fallback_key_matches_consumer(self):
        """Fallback dict must expose its item under the consumer-side key.

        Downstream consumers in `_process_chat_data` (line 397) and
        `_process_transfer_chat_data` (line 434) both read `"memory list"`
        (with space). The fallback dict therefore MUST use the same key, or it
        is effectively dead code and the request stores nothing.
        """
        # Force `_safe_parse` to behave as if the LLM returned unparseable
        # output (the realistic failure mode reported in #1493 / #1355).
        self.reader.llm.generate.return_value = "this is not json at all"

        result = self.reader._get_llm_response("I like strawberry.", custom_tags=None)

        self.assertIn(
            "memory list",
            result,
            "Fallback dict must use the consumer-side key 'memory list' (with space). "
            "Using 'memory_list' (underscore) leaves the fallback unreachable.",
        )
        self.assertEqual(len(result["memory list"]), 1)
        item = result["memory list"][0]
        self.assertEqual(item["memory_type"], "UserMemory")
        self.assertEqual(item["value"], "I like strawberry.")

    def test_process_chat_data_fine_yields_node_when_llm_unparseable(self):
        """End-to-end: fine-mode `_process_chat_data` must still produce a
        `TextualMemoryItem` when the LLM output is unparseable JSON.

        This is the symptom-level test for #1493: an `/product/add` call
        carrying `"I like strawberry."` should result in at least one memory
        item even when the LLM emits non-JSON chatter.
        """
        # Realistic Kimi-K2 style failure: LLM wraps response in chatter so
        # `parse_json_result` returns `{}`, `_safe_parse` returns `None`,
        # `not response_json` is True and the fallback fires.
        self.reader.llm.generate.return_value = (
            "Here is what I extracted: ... unfortunately I cannot output JSON."
        )

        scene_data_info = [{"role": "user", "content": "I like strawberry."}]
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.reader._process_chat_data(scene_data_info, info, mode="fine")

        self.assertIsInstance(result, list)
        self.assertGreaterEqual(
            len(result),
            1,
            "Fallback must produce at least one TextualMemoryItem when LLM "
            "output cannot be parsed; otherwise /product/add stores nothing "
            "while still returning 200.",
        )
        self.assertIsInstance(result[0], TextualMemoryItem)
        # The fallback value contains the original user input verbatim.
        self.assertIn("strawberry", result[0].memory)


if __name__ == "__main__":
    unittest.main()
