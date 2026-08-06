"""Test SystemParser to ensure system messages are handled correctly."""

import unittest

from unittest.mock import MagicMock

from memos.mem_reader.read_multi_modal.system_parser import SystemParser


class TestSystemParser(unittest.TestCase):
    """Test SystemParser behavior with different system message types."""

    def setUp(self):
        """Set up test fixtures."""
        # Mock embedder
        self.mock_embedder = MagicMock()
        self.mock_embedder.embed.return_value = [[0.1] * 128]  # Mock embedding vector

        # Create SystemParser instance with mocked embedder
        self.parser = SystemParser(embedder=self.mock_embedder)

    def test_parse_fast_with_tool_schema_defers_to_fine_mode(self):
        """Test that parse_fast does NOT store tool schema messages directly.

        Tool schema storage is deferred to parse_fine; parse_fast should return
        an empty list even when a <tool_schema> block is present.
        """
        message = {
            "role": "system",
            "content": '<tool_schema>[{"type": "function", "function": {"name": "test_tool"}}]</tool_schema>',
            "chat_time": "2025-06-04T10:00:00",
            "message_id": "msg_001",
        }
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.parser.parse_fast(message, info)

        self.assertIsInstance(result, list)
        self.assertEqual(
            len(result), 0, "parse_fast should defer tool schema storage to parse_fine"
        )

    def test_parse_fine_with_tool_schema_creates_tool_schema_memory(self):
        """Test that parse_fine creates ToolSchemaMemory items from tool schema content."""
        message = {
            "role": "system",
            "content": '[{"type": "function", "function": {"name": "test_tool"}}]',
            "chat_time": "2025-06-04T10:00:00",
            "message_id": "msg_001",
        }
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.parser.parse_fine(message, info)

        # Should return memory items for tool schemas
        self.assertIsInstance(result, list)
        self.assertGreater(len(result), 0, "Tool schema should create memory items")
        self.assertEqual(result[0].metadata.memory_type, "ToolSchemaMemory")

    def test_parse_fast_with_regular_system_prompt_returns_empty(self):
        """Test that regular system prompts (without tool schemas) do NOT create memory items."""
        message = {
            "role": "system",
            "content": "You are a helpful AI assistant. Please follow these instructions carefully.",
            "chat_time": "2025-06-04T10:00:00",
            "message_id": "msg_002",
        }
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.parser.parse_fast(message, info)

        # Regular system prompts should NOT be stored as memory
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 0, "Regular system prompts should not create memory items")

    def test_parse_fast_with_internal_review_prompt_returns_empty(self):
        """Test that internal review prompts are NOT stored as memory chunks."""
        message = {
            "role": "system",
            "content": "Internal Review: The conversation above contains sensitive information. "
            "Please analyze and extract key points while maintaining confidentiality.",
            "chat_time": "2025-06-04T10:00:00",
            "message_id": "msg_003",
        }
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.parser.parse_fast(message, info)

        # Internal review prompts should NOT be stored
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 0, "Internal review prompts should not create memory items")

    def test_parse_fast_with_empty_content_returns_empty(self):
        """Test that empty system messages return empty list."""
        message = {
            "role": "system",
            "content": "",
            "chat_time": "2025-06-04T10:00:00",
            "message_id": "msg_004",
        }
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.parser.parse_fast(message, info)

        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 0)

    def test_parse_fine_preserves_tool_schema_memory_type(self):
        """Test that tool schemas are correctly identified and stored with ToolSchemaMemory type."""
        tool_schema_content = """[
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather information",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string"}
                        }
                    }
                }
            }
        ]"""
        message = {
            "role": "system",
            "content": tool_schema_content,
            "chat_time": "2025-06-04T10:00:00",
            "message_id": "msg_005",
        }
        info = {"user_id": "user1", "session_id": "session1"}

        result = self.parser.parse_fine(message, info)

        self.assertGreater(len(result), 0)
        # Verify all returned items are ToolSchemaMemory
        for item in result:
            self.assertEqual(
                item.metadata.memory_type,
                "ToolSchemaMemory",
                "Tool schemas must be stored as ToolSchemaMemory, not LongTermMemory",
            )


if __name__ == "__main__":
    unittest.main()
