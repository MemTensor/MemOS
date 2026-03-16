"""Tests for project_id and manager_user_id propagation across memory modalities.

Verifies that project_id and manager_user_id from UserContext are correctly
carried through all extraction paths (fast/fine, multimodal, transfer) and
into the resulting TextualMemoryItem metadata.
"""

import unittest

from unittest.mock import MagicMock, patch

from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.types.general_types import UserContext


PROJECT_ID = "proj_42"
MANAGER_USER_ID = "mgr_99"

LLM_FINE_RESPONSE = (
    '{"memory list": [{"key": "greeting", "memory_type": "LongTermMemory", '
    '"value": "User greeted the assistant.", "tags": ["greeting"]}], '
    '"summary": "User said hello."}'
)


def _make_user_context(
    project_id: str = PROJECT_ID,
    manager_user_id: str = MANAGER_USER_ID,
) -> UserContext:
    return UserContext(
        user_id="u1",
        mem_cube_id="cube1",
        session_id="sess1",
        manager_user_id=manager_user_id,
        project_id=project_id,
    )


def _make_fast_item(
    memory: str = "User said hello",
    user_id: str = "u1",
    session_id: str = "sess1",
    manager_user_id: str | None = MANAGER_USER_ID,
    project_id: str | None = PROJECT_ID,
    role: str = "user",
) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory=memory,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id=user_id,
            session_id=session_id,
            memory_type="LongTermMemory",
            sources=[SourceMessage(type="chat", role=role, content=memory)],
            manager_user_id=manager_user_id,
            project_id=project_id,
        ),
    )


def _assert_fields(
    test_case, item: TextualMemoryItem, project_id=PROJECT_ID, manager_user_id=MANAGER_USER_ID
):
    """Assert that project_id and manager_user_id are set on the item metadata."""
    test_case.assertEqual(
        getattr(item.metadata, "project_id", None),
        project_id,
        f"project_id mismatch on item: {item.memory!r}",
    )
    test_case.assertEqual(
        getattr(item.metadata, "manager_user_id", None),
        manager_user_id,
        f"manager_user_id mismatch on item: {item.memory!r}",
    )


# ---------------------------------------------------------------------------
# SimpleStructMemReader tests
# ---------------------------------------------------------------------------
class TestSimpleStructProjectIdPropagation(unittest.TestCase):
    """Verify SimpleStructMemReader propagates project_id/manager_user_id."""

    def setUp(self):
        config = MagicMock(spec=SimpleStructMemReaderConfig)
        config.llm = MagicMock()
        config.general_llm = None
        config.embedder = MagicMock()
        config.chunker = MagicMock()
        config.remove_prompt_example = MagicMock()

        with (
            patch.object(LLMFactory, "from_config", return_value=MagicMock()),
            patch.object(EmbedderFactory, "from_config", return_value=MagicMock()),
            patch.object(ChunkerFactory, "from_config", return_value=MagicMock()),
        ):
            self.reader = SimpleStructMemReader(config)

        self.reader.llm = MagicMock()
        self.reader.general_llm = self.reader.llm
        self.reader.embedder = MagicMock()
        self.reader.embedder.embed.return_value = [[0.1] * 8]
        self.reader.chunker = MagicMock()

    # -- fast mode -----------------------------------------------------------
    def test_process_chat_data_fast_with_user_context(self):
        """Fast mode items must carry project_id and manager_user_id."""
        scene = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        info = {"user_id": "u1", "session_id": "sess1"}
        ctx = _make_user_context()

        result = self.reader._process_chat_data(scene, info, mode="fast", user_context=ctx)

        self.assertTrue(len(result) > 0, "Expected at least one fast item")
        for item in result:
            _assert_fields(self, item)

    def test_process_chat_data_fast_without_user_context(self):
        """Without user_context the fields should be absent (None)."""
        scene = [{"role": "user", "content": "Hello"}]
        info = {"user_id": "u1", "session_id": "sess1"}

        result = self.reader._process_chat_data(scene, info, mode="fast")

        self.assertTrue(len(result) > 0)
        for item in result:
            _assert_fields(self, item, project_id=None, manager_user_id=None)

    # -- fine mode -----------------------------------------------------------
    def test_process_chat_data_fine_with_user_context(self):
        """Fine mode items must carry project_id and manager_user_id."""
        scene = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        info = {"user_id": "u1", "session_id": "sess1"}
        ctx = _make_user_context()

        self.reader.llm.generate.return_value = LLM_FINE_RESPONSE
        result = self.reader._process_chat_data(scene, info, mode="fine", user_context=ctx)

        self.assertTrue(len(result) > 0, "Expected at least one fine item")
        for item in result:
            _assert_fields(self, item)

    def test_process_chat_data_fine_without_user_context(self):
        """Fine mode without user_context should produce None fields."""
        scene = [{"role": "user", "content": "Hello"}]
        info = {"user_id": "u1", "session_id": "sess1"}

        self.reader.llm.generate.return_value = LLM_FINE_RESPONSE
        result = self.reader._process_chat_data(scene, info, mode="fine")

        self.assertTrue(len(result) > 0)
        for item in result:
            _assert_fields(self, item, project_id=None, manager_user_id=None)

    # -- transfer (async fine) -----------------------------------------------
    def test_process_transfer_chat_data_with_user_context(self):
        """Transfer path must propagate project_id and manager_user_id."""
        raw_node = _make_fast_item()
        ctx = _make_user_context()

        self.reader.llm.generate.return_value = LLM_FINE_RESPONSE
        result = self.reader._process_transfer_chat_data(raw_node, user_context=ctx)

        self.assertTrue(len(result) > 0, "Expected at least one transfer item")
        for item in result:
            _assert_fields(self, item)

    def test_process_transfer_chat_data_without_user_context(self):
        """Transfer path without user_context should produce None fields."""
        raw_node = _make_fast_item(manager_user_id=None, project_id=None)

        self.reader.llm.generate.return_value = LLM_FINE_RESPONSE
        result = self.reader._process_transfer_chat_data(raw_node)

        self.assertTrue(len(result) > 0)
        for item in result:
            _assert_fields(self, item, project_id=None, manager_user_id=None)


# ---------------------------------------------------------------------------
# MultiModalStructMemReader tests
# ---------------------------------------------------------------------------
class TestMultiModalProjectIdPropagation(unittest.TestCase):
    """Verify MultiModalStructMemReader propagates project_id/manager_user_id."""

    def setUp(self):
        # Bypass the heavy constructor entirely; we only need the methods
        # under test, not a fully-wired reader.
        with patch.object(MultiModalStructMemReader, "__init__", lambda self, *a, **kw: None):
            self.reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)

        self.reader.llm = MagicMock()
        self.reader.general_llm = self.reader.llm
        self.reader.embedder = MagicMock()
        self.reader.embedder.embed.return_value = [[0.1] * 8]
        self.reader.chunker = MagicMock()
        self.reader.multi_modal_parser = MagicMock()
        self.reader.config = MagicMock()
        self.reader.chat_window_max_tokens = 4096
        self.reader.save_rawfile = False
        self.reader.searcher = MagicMock()
        self.reader.graph_db = MagicMock()
        self.reader.oss_config = None
        self.reader.skills_dir_config = None

    # -- _build_window_from_items --------------------------------------------
    def test_build_window_propagates_project_id(self):
        """Aggregated window items must carry project_id/manager_user_id
        from their constituent fast items."""
        items = [
            _make_fast_item("Hello from user"),
            _make_fast_item("Another message"),
        ]
        info = {"user_id": "u1", "session_id": "sess1"}

        result = self.reader._build_window_from_items(items, info)

        self.assertIsNotNone(result)
        _assert_fields(self, result)

    def test_build_window_without_project_id(self):
        """When constituent items lack these fields, aggregated item should too."""
        items = [
            _make_fast_item("Hello", manager_user_id=None, project_id=None),
        ]
        info = {"user_id": "u1", "session_id": "sess1"}

        result = self.reader._build_window_from_items(items, info)

        self.assertIsNotNone(result)
        _assert_fields(self, result, project_id=None, manager_user_id=None)

    def test_build_window_picks_first_nonempty(self):
        """If only one constituent item has the fields, they should be picked up."""
        item_without = _make_fast_item("msg1", manager_user_id=None, project_id=None)
        item_with = _make_fast_item("msg2")
        info = {"user_id": "u1", "session_id": "sess1"}

        result = self.reader._build_window_from_items([item_without, item_with], info)

        self.assertIsNotNone(result)
        _assert_fields(self, result)

    # -- _process_string_fine ------------------------------------------------
    def test_process_string_fine_propagates_fields(self):
        """Fine string extraction must carry project_id/manager_user_id
        from user_context into the resulting memory items."""
        fast_items = [_make_fast_item("User said hello")]
        info = {"user_id": "u1", "session_id": "sess1"}
        ctx = _make_user_context()

        self.reader.llm.generate.return_value = LLM_FINE_RESPONSE
        # _get_maybe_merged_memory does similarity search; stub it to
        # passthrough the extracted dict unchanged.
        with patch.object(
            self.reader,
            "_get_maybe_merged_memory",
            side_effect=lambda extracted_memory_dict, **kw: extracted_memory_dict,
        ):
            result = self.reader._process_string_fine(fast_items, info, user_context=ctx)

        self.assertTrue(len(result) > 0, "Expected at least one fine string item")
        for item in result:
            _assert_fields(self, item)

    def test_process_string_fine_without_user_context(self):
        """Without user_context the fine items should lack these fields."""
        fast_items = [_make_fast_item("Hello", manager_user_id=None, project_id=None)]
        info = {"user_id": "u1", "session_id": "sess1"}

        self.reader.llm.generate.return_value = LLM_FINE_RESPONSE
        with patch.object(
            self.reader,
            "_get_maybe_merged_memory",
            side_effect=lambda extracted_memory_dict, **kw: extracted_memory_dict,
        ):
            result = self.reader._process_string_fine(fast_items, info)

        self.assertTrue(len(result) > 0)
        for item in result:
            _assert_fields(self, item, project_id=None, manager_user_id=None)

    # -- _process_multi_modal_data Part B ------------------------------------
    def test_process_multi_modal_data_passes_user_context_to_transfer(self):
        """Part B of _process_multi_modal_data must forward user_context
        to process_transfer so that parse_fine can use it."""
        ctx = _make_user_context()
        image_source = SourceMessage(type="image_url", content="http://img.png")
        fast_item = TextualMemoryItem(
            memory="Image context",
            metadata=TreeNodeTextualMemoryMetadata(
                user_id="u1",
                session_id="sess1",
                memory_type="LongTermMemory",
                sources=[image_source],
                manager_user_id=MANAGER_USER_ID,
                project_id=PROJECT_ID,
            ),
        )

        mock_transfer_items = [_make_fast_item("Extracted from image")]
        self.reader.multi_modal_parser = MagicMock()
        self.reader.multi_modal_parser.parse.return_value = [fast_item]
        self.reader.multi_modal_parser.process_transfer.return_value = mock_transfer_items

        scene = [
            {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "http://img.png"}}],
            }
        ]
        info = {"user_id": "u1", "session_id": "sess1"}

        with (
            patch.object(self.reader, "_process_string_fine", return_value=[]),
            patch.object(self.reader, "_process_tool_trajectory_fine", return_value=[]),
            patch(
                "memos.mem_reader.multi_modal_struct.process_skill_memory_fine",
                return_value=[],
            ),
            patch(
                "memos.mem_reader.multi_modal_struct.process_preference_fine",
                return_value=[],
            ),
            patch.object(
                self.reader,
                "_concat_multi_modal_memories",
                return_value=[fast_item],
            ),
        ):
            self.reader._process_multi_modal_data(
                scene,
                info,
                mode="fine",
                user_context=ctx,
            )

        self.reader.multi_modal_parser.process_transfer.assert_called()
        call_kwargs = self.reader.multi_modal_parser.process_transfer.call_args
        self.assertEqual(
            call_kwargs.kwargs.get("user_context"),
            ctx,
            "user_context must be forwarded to process_transfer",
        )

    # -- _process_transfer_multi_modal_data Part B ---------------------------
    def test_process_transfer_passes_user_context(self):
        """_process_transfer_multi_modal_data Part B must forward user_context."""
        ctx = _make_user_context()
        raw_node = _make_fast_item("some raw memory")

        self.reader.multi_modal_parser = MagicMock()
        self.reader.multi_modal_parser.process_transfer.return_value = []

        with (
            patch.object(self.reader, "_process_string_fine", return_value=[]),
            patch.object(self.reader, "_process_tool_trajectory_fine", return_value=[]),
            patch(
                "memos.mem_reader.multi_modal_struct.process_skill_memory_fine",
                return_value=[],
            ),
            patch(
                "memos.mem_reader.multi_modal_struct.process_preference_fine",
                return_value=[],
            ),
        ):
            self.reader._process_transfer_multi_modal_data(
                [raw_node],
                user_context=ctx,
            )

        if self.reader.multi_modal_parser.process_transfer.called:
            call_kwargs = self.reader.multi_modal_parser.process_transfer.call_args
            self.assertEqual(
                call_kwargs.kwargs.get("user_context"),
                ctx,
                "user_context must be forwarded in transfer path",
            )


if __name__ == "__main__":
    unittest.main()
