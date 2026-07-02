import unittest

from unittest.mock import MagicMock, patch

from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.mem_reader.utils import build_chat_extraction_messages, parse_json_result
from memos.memories.textual.item import TextualMemoryItem


class TestSimpleStructMemReader(unittest.TestCase):
    def setUp(self):
        # Mock config
        self.config = MagicMock(spec=SimpleStructMemReaderConfig)
        self.config.llm = MagicMock()
        self.config.general_llm = None  # Optional, falls back to main llm
        self.config.embedder = MagicMock()
        self.config.chunker = MagicMock()
        self.config.remove_prompt_example = MagicMock()

        # Mock dependencies
        with (
            patch.object(LLMFactory, "from_config", return_value=MagicMock()),
            patch.object(EmbedderFactory, "from_config", return_value=MagicMock()),
            patch.object(ChunkerFactory, "from_config", return_value=MagicMock()),
        ):
            self.reader = SimpleStructMemReader(self.config)

        # Set up mock LLM and embedder
        self.reader.llm = MagicMock()
        self.reader.general_llm = self.reader.llm  # Falls back to main llm
        self.reader.embedder = MagicMock()
        self.reader.chunker = MagicMock()

    def test_init(self):
        """Test initialization of the reader."""
        self.assertIsNotNone(self.reader.config)
        self.assertIsNotNone(self.reader.llm)
        self.assertIsNotNone(self.reader.embedder)

    def test_process_chat_data(self):
        """Test processing chat data into memory items."""
        scene_data_info = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
            {"role": "user", "content": "How are you?"},
        ]
        info = {"user_id": "user1", "session_id": "session1"}

        # Mock LLM response

        mock_response = (
            '{"memory list": [{"key": "Planned scope adjustment", "memory_type": "UserMemory", '
            '"value": "Tom planned to suggest in a meeting on June 27, 2025 at 9:30 AM", '
            '"tags": ["planning", "deadline change", "feature prioritization"]}], '
            '"summary": "Tom is currently focused on managing a new project with a tight schedule."}'
        )
        self.reader.llm.generate.return_value = mock_response

        result = self.reader._process_chat_data(scene_data_info, info)

        self.assertIsInstance(result, list)
        self.assertIsInstance(result[0], TextualMemoryItem)
        self.assertEqual(
            result[0].memory, "Tom planned to suggest in a meeting on June 27, 2025 at 9:30 AM"
        )
        self.assertEqual(result[0].metadata.user_id, "user1")

    def test_get_scene_data_info_with_chat(self):
        """Test extracting chat info from scene data."""
        scene_data = [
            [
                {
                    "role": "user",
                    "chat_time": "3 May 2025",
                    "content": "I'm feeling a bit down today.",
                },
                {
                    "role": "assistant",
                    "chat_time": "3 May 2025",
                    "content": "I'm sorry to hear that. Do you want to talk about what's been going on?",
                },
                {
                    "role": "user",
                    "chat_time": "3 May 2025",
                    "content": "It's just been a tough couple of days...",
                },
            ],
        ]
        result = self.reader.get_scene_data_info(scene_data, type="chat")

        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 1)
        self.assertEqual(
            result[0][0],
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "I'm feeling a bit down today.",
            },
        )

    def test_parse_json_result_success(self):
        """Test successful JSON parsing."""
        raw_response = '{"summary": "Test summary", "tags": ["test"]}'
        result = parse_json_result(raw_response)

        self.assertIsInstance(result, dict)
        self.assertIn("summary", result)

    def test_parse_json_result_failure(self):
        """Test failure in JSON parsing."""
        raw_response = "Invalid JSON string"
        result = parse_json_result(raw_response)

        self.assertEqual(result, {})

    def test_get_llm_response_uses_system_and_user_messages(self):
        """Regression for #1269: weak models reply to the conversation
        instead of summarising because the entire prompt (instructions +
        examples + conversation + ``Your Output:`` trailer) was being sent
        as a single ``user`` message. The chat extraction path must split
        the prompt into a system message (instructions / examples / format)
        and a user message (conversation block + JSON-only trailer).
        """
        captured: list[list[dict]] = []

        def fake_generate(messages):
            captured.append(messages)
            return (
                '{"memory list": [{"key": "k", "memory_type": "UserMemory", '
                '"value": "v", "tags": []}], "summary": "real summary"}'
            )

        self.reader.llm.generate.side_effect = fake_generate
        self.reader.embedder.embed.return_value = [[0.0]]

        self.reader._get_llm_response(
            "user: [2025-06-29 10:00]: Hello, how are you?\n"
            "assistant: I'm fine, thanks. And you?\n"
            "user: [2025-06-29 10:01]: Pretty good.\n",
            custom_tags=None,
        )

        assert captured, "LLM was not called"
        messages = captured[0]
        roles = [m["role"] for m in messages]
        self.assertEqual(
            roles[:2],
            ["system", "user"],
            f"chat extraction must send a system+user pair, got {roles!r}",
        )

        system_content = messages[0]["content"]
        user_content = messages[1]["content"]

        # Instructions / examples / format spec must live in the system
        # message, not the user message.
        self.assertIn("memory extraction expert", system_content)
        self.assertIn('"summary"', system_content)
        self.assertNotIn("memory extraction expert", user_content)

        # User message must carry the conversation block + an explicit
        # "JSON only, do not reply" trailer that prevents small models
        # from continuing the embedded chat.
        self.assertIn("Conversation:", user_content)
        self.assertIn("Pretty good.", user_content)
        self.assertIn("JSON", user_content)
        self.assertNotIn("Your Output:", user_content)

    def test_build_chat_extraction_messages_fallback(self):
        """When no Conversation: marker is present (doc / general string
        templates), the helper falls back to a single user message so that
        callers outside the chat path are unaffected.
        """
        msgs = build_chat_extraction_messages("plain prompt without marker")
        self.assertEqual(msgs, [{"role": "user", "content": "plain prompt without marker"}])

    def test_get_llm_response_fallback_key_matches_consumer(self):
        """Regression test for issue #1355.

        When the LLM response cannot be parsed as JSON, `_get_llm_response`
        is expected to return a fallback dict whose ``"memory list"`` (with
        a single space) entry contains one salvaged ``UserMemory`` item built
        from the raw user input. Downstream consumers in
        ``_process_chat_data`` read ``resp.get("memory list", [])`` — if the
        fallback uses the wrong key (e.g. ``"memory_list"`` with an
        underscore) the salvaged memory is silently dropped and the request
        produces zero memories despite returning HTTP 200.
        """
        # Force `_safe_parse` to return None so the fallback branch is taken.
        self.reader.llm.generate.return_value = "not-valid-json"
        self.reader.config.remove_prompt_example = False

        resp = self.reader._get_llm_response("test memory content", custom_tags=None)

        # The fallback must use the "memory list" (with space) key the
        # rest of the pipeline reads; verify the salvaged item shape too.
        salvaged = resp.get("memory list", [])
        self.assertEqual(
            len(salvaged),
            1,
            f"Fallback memory list must contain exactly one salvaged item, got: {resp!r}",
        )
        self.assertEqual(salvaged[0]["value"], "test memory content")
        self.assertEqual(salvaged[0]["memory_type"], "UserMemory")

    def test_process_chat_data_fine_yields_node_when_llm_unparseable(self):
        """Regression test for issue #1355 (end-to-end of the reader stage).

        With Kimi-style outputs that fail strict JSON parsing,
        ``_process_chat_data`` (fine mode) should still emit a fallback
        ``TextualMemoryItem`` so that the upstream `/product/add` request
        ultimately writes at least one node to Neo4j instead of returning
        200 with zero stored memories.
        """
        # Embedder produces a stable embedding for the salvaged item.
        self.reader.embedder.embed = MagicMock(return_value=[[0.1, 0.2, 0.3]])
        # LLM returns garbage so `_safe_parse` returns None and the fallback
        # in `_get_llm_response` is exercised.
        self.reader.llm.generate.return_value = "I cannot produce JSON sorry"
        self.reader.config.remove_prompt_example = False

        scene_data_info = [{"role": "user", "content": "test memory content"}]
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.reader._process_chat_data(scene_data_info, info, mode="fine")

        self.assertIsInstance(result, list)
        self.assertEqual(
            len(result),
            1,
            "fine-mode _process_chat_data must produce one salvaged memory "
            "item when LLM output is unparseable (bug #1355)",
        )
        self.assertIsInstance(result[0], TextualMemoryItem)
        self.assertIn("test memory content", result[0].memory)


if __name__ == "__main__":
    unittest.main()
