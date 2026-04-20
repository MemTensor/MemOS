import unittest

from unittest.mock import MagicMock, patch

from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.simple_struct import SimpleStructMemReader, _merge_custom_tags
from memos.mem_reader.utils import parse_json_result
from memos.memories.textual.item import TextualMemoryItem


class TestMergeCustomTags(unittest.TestCase):
    def test_appends_custom_tags_preserving_mode_tag(self):
        self.assertEqual(
            _merge_custom_tags(["mode:fast"], ["finance", "quarterly"]),
            ["mode:fast", "finance", "quarterly"],
        )

    def test_deduplicates_overlap(self):
        self.assertEqual(
            _merge_custom_tags(["mode:fast", "finance"], ["finance", "quarterly"]),
            ["mode:fast", "finance", "quarterly"],
        )

    def test_no_custom_tags_is_noop(self):
        self.assertEqual(_merge_custom_tags(["mode:fast"], None), ["mode:fast"])
        self.assertEqual(_merge_custom_tags(["mode:fast"], []), ["mode:fast"])

    def test_tolerates_none_and_non_list(self):
        self.assertEqual(_merge_custom_tags(None, ["x", "y"]), ["x", "y"])
        self.assertEqual(_merge_custom_tags("not-a-list", ["a"]), ["a"])
        self.assertEqual(_merge_custom_tags(None, None), [])


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

    def test_process_chat_data_fast_mode_merges_custom_tags(self):
        """Fast mode should keep ``mode:fast`` AND append user-supplied custom_tags."""
        scene_data_info = [
            {"role": "user", "content": "Q1 revenue was up 12 percent"},
        ]
        info = {
            "user_id": "user1",
            "session_id": "session1",
            "source_type": "web",
            "custom_tags": ["finance", "quarterly"],
        }
        # Stub the embedder so _make_memory_item doesn't need a real model.
        self.reader.embedder.embed.return_value = [[0.0]]

        result = self.reader._process_chat_data(scene_data_info, info, mode="fast")

        self.assertEqual(len(result), 1)
        tags = result[0].metadata.tags
        self.assertIn("mode:fast", tags)
        self.assertIn("finance", tags)
        self.assertIn("quarterly", tags)
        # User-supplied info keys outside reserved set should survive.
        self.assertEqual(result[0].metadata.info.get("source_type"), "web")
        # custom_tags itself is popped off info before storage.
        self.assertNotIn("custom_tags", result[0].metadata.info)

    def test_process_chat_data_fast_mode_without_custom_tags(self):
        """Baseline: without custom_tags the behavior is unchanged."""
        scene_data_info = [{"role": "user", "content": "hello"}]
        info = {"user_id": "u", "session_id": "s"}
        self.reader.embedder.embed.return_value = [[0.0]]

        result = self.reader._process_chat_data(scene_data_info, info, mode="fast")

        self.assertEqual(result[0].metadata.tags, ["mode:fast"])

    def test_process_chat_data_fine_mode_merges_custom_tags(self):
        """Fine mode should enforce the custom_tags merge even if the LLM skips them."""
        scene_data_info = [{"role": "user", "content": "Q1 revenue was up 12 percent"}]
        info = {
            "user_id": "user1",
            "session_id": "session1",
            "custom_tags": ["finance", "quarterly"],
        }
        # LLM returns tags that do NOT include the user-supplied custom_tags.
        self.reader.llm.generate.return_value = (
            '{"memory list": [{"key": "Q1 revenue", "memory_type": "LongTermMemory", '
            '"value": "Q1 revenue was up 12 percent", "tags": ["revenue"]}], '
            '"summary": ""}'
        )
        self.reader.embedder.embed.return_value = [[0.0]]

        result = self.reader._process_chat_data(scene_data_info, info, mode="fine")

        self.assertEqual(len(result), 1)
        tags = result[0].metadata.tags
        self.assertIn("revenue", tags)
        self.assertIn("finance", tags)
        self.assertIn("quarterly", tags)

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


if __name__ == "__main__":
    unittest.main()
