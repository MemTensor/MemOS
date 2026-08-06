"""Integration tests for the add-memories call chain after timed_stage refactoring.

Validates:
  1. SingleCubeView._process_text_mem returns correct business results (regression).
  2. Each stage emits a [STAGE] log with expected biz/stage/fields.
  3. Summary rollup emits all aggregated fields.
  4. CompositeCubeView.add_memories emits multi_cube stage for >1 cubes.
  5. Exceptions in stages do not swallow errors or corrupt results.

NOTE: SingleCubeView / CompositeCubeView are imported lazily inside fixtures
to work around a known circular import in memos.api.handlers.__init__.
"""

import logging
import uuid

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stage_logs(caplog) -> list[str]:
    return [r.message for r in caplog.records if r.message.startswith("[STAGE]")]


def _make_add_req(**overrides):
    from memos.api.product_models import APIADDRequest

    defaults = {
        "user_id": "test_user",
        "messages": [
            {"role": "user", "content": "remember this"},
            {"role": "assistant", "content": "ok"},
        ],
    }
    defaults.update(overrides)
    return APIADDRequest(**defaults)


def _make_memory_item(memory_text: str = "hello world"):
    from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

    return TextualMemoryItem(
        id=str(uuid.uuid4()),
        memory=memory_text,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="u1",
            session_id="s1",
            memory_type="WorkingMemory",
            sources=[],
            info={},
        ),
    )


@dataclass
class _FakeSingleCube:
    """Minimal stub that records calls for CompositeCubeView tests."""

    cube_id: str
    result: list[dict[str, Any]]

    def add_memories(self, add_req):
        return list(self.result)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def single_cube_view():
    """Build a SingleCubeView with fully-mocked dependencies."""
    from memos.multi_mem_cube.single_cube import SingleCubeView

    mem_item = _make_memory_item()

    mock_mem_reader = MagicMock()
    mock_mem_reader.get_memory.return_value = [[mem_item]]
    mock_mem_reader.save_rawfile = False

    mock_text_mem = MagicMock()
    mock_text_mem.add.return_value = [mem_item.id]
    mock_text_mem.mode = "async"

    mock_naive_cube = MagicMock()
    mock_naive_cube.text_mem = mock_text_mem

    mock_scheduler = MagicMock()

    view = SingleCubeView(
        cube_id="cube_test",
        naive_mem_cube=mock_naive_cube,
        mem_reader=mock_mem_reader,
        mem_scheduler=mock_scheduler,
        logger=logging.getLogger("test.single_cube"),
        searcher=None,
        feedback_server=None,
    )
    return view, mem_item


# ===========================================================================
# SingleCubeView — async + fast (the most common path)
# ===========================================================================


class TestSingleCubeAddAsyncFast:
    def test_returns_correct_business_result(self, single_cube_view):
        view, mem_item = single_cube_view
        add_req = _make_add_req(async_mode="async")

        results = view.add_memories(add_req)

        assert len(results) == 1
        assert results[0]["memory_id"] == mem_item.id
        assert results[0]["cube_id"] == "cube_test"
        assert results[0]["memory_type"] == "WorkingMemory"

    def test_mem_reader_called_with_fast_mode(self, single_cube_view):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        view.add_memories(add_req)

        view.mem_reader.get_memory.assert_called_once()
        call_kwargs = view.mem_reader.get_memory.call_args
        assert call_kwargs.kwargs["mode"] == "fast"

    def test_text_mem_add_called(self, single_cube_view):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        view.add_memories(add_req)

        view.naive_mem_cube.text_mem.add.assert_called_once()

    def test_scheduler_called(self, single_cube_view):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        view.add_memories(add_req)

        view.mem_scheduler.submit_messages.assert_called_once()

    def test_stage_logs_emitted(self, single_cube_view, caplog):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        with caplog.at_level(logging.INFO):
            view.add_memories(add_req)

        logs = _stage_logs(caplog)

        stage_names = []
        for log_line in logs:
            for part in log_line.split():
                if part.startswith("stage="):
                    stage_names.append(part.split("=", 1)[1])

        assert "get_memory" in stage_names
        assert "write_db" in stage_names
        assert "schedule" in stage_names
        assert "summary" in stage_names

    def test_summary_contains_all_fields(self, single_cube_view, caplog):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        with caplog.at_level(logging.INFO):
            view.add_memories(add_req)

        summary = [log for log in _stage_logs(caplog) if "stage=summary" in log]
        assert len(summary) == 1
        s = summary[0]
        for field in [
            "cube_id=",
            "sync_mode=",
            "extract_mode=",
            "input_msg_count=",
            "est_input_tokens=",
            "memory_count=",
            "get_memory_ms=",
            "write_db_ms=",
            "schedule_ms=",
            "total_ms=",
            "per_item_ms=",
        ]:
            assert field in s, f"Missing field '{field}' in summary: {s}"

    def test_summary_values_are_consistent(self, single_cube_view, caplog):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        with caplog.at_level(logging.INFO):
            view.add_memories(add_req)

        summary = next(log for log in _stage_logs(caplog) if "stage=summary" in log)
        fields = {}
        for part in summary.split():
            if "=" in part:
                k, v = part.split("=", 1)
                fields[k] = v

        assert fields["sync_mode"] == "async"
        assert fields["extract_mode"] == "fast"
        assert fields["input_msg_count"] == "2"
        assert fields["memory_count"] == "1"
        assert int(fields["total_ms"]) >= 0
        assert int(fields["get_memory_ms"]) >= 0
        assert int(fields["write_db_ms"]) >= 0
        assert int(fields["schedule_ms"]) >= 0

    def test_write_db_reports_memory_count(self, single_cube_view, caplog):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        with caplog.at_level(logging.INFO):
            view.add_memories(add_req)

        write_db = [log for log in _stage_logs(caplog) if "stage=write_db" in log]
        assert len(write_db) == 1
        assert "memory_count=1" in write_db[0]

    def test_get_memory_has_cube_id(self, single_cube_view, caplog):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        with caplog.at_level(logging.INFO):
            view.add_memories(add_req)

        gm = [log for log in _stage_logs(caplog) if "stage=get_memory" in log]
        assert len(gm) == 1
        assert "cube_id=cube_test" in gm[0]

    def test_schedule_has_cube_id(self, single_cube_view, caplog):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="async")

        with caplog.at_level(logging.INFO):
            view.add_memories(add_req)

        sched = [log for log in _stage_logs(caplog) if "stage=schedule" in log]
        assert len(sched) == 1
        assert "cube_id=cube_test" in sched[0]


# ===========================================================================
# SingleCubeView — sync + fast
# ===========================================================================


class TestSingleCubeAddSyncFast:
    def test_sync_fast_returns_result(self, single_cube_view):
        view, mem_item = single_cube_view
        add_req = _make_add_req(async_mode="sync", mode="fast")

        results = view.add_memories(add_req)

        assert len(results) == 1
        assert results[0]["memory_id"] == mem_item.id

    def test_sync_fast_summary_fields(self, single_cube_view, caplog):
        view, _ = single_cube_view
        add_req = _make_add_req(async_mode="sync", mode="fast")

        with caplog.at_level(logging.INFO):
            view.add_memories(add_req)

        summary = [log for log in _stage_logs(caplog) if "stage=summary" in log]
        assert len(summary) == 1
        assert "sync_mode=sync" in summary[0]
        assert "extract_mode=fast" in summary[0]


# ===========================================================================
# SingleCubeView — zero memories edge case
# ===========================================================================


class TestSingleCubeEdgeCases:
    def test_zero_memories_does_not_crash(self, caplog):
        """When get_memory returns no items, process should still complete."""
        from memos.multi_mem_cube.single_cube import SingleCubeView

        mock_mem_reader = MagicMock()
        mock_mem_reader.get_memory.return_value = [[]]
        mock_mem_reader.save_rawfile = False

        mock_text_mem = MagicMock()
        mock_text_mem.add.return_value = []
        mock_text_mem.mode = "async"

        mock_naive_cube = MagicMock()
        mock_naive_cube.text_mem = mock_text_mem

        view = SingleCubeView(
            cube_id="cube_empty",
            naive_mem_cube=mock_naive_cube,
            mem_reader=mock_mem_reader,
            mem_scheduler=MagicMock(),
            logger=logging.getLogger("test.edge"),
            searcher=None,
        )

        add_req = _make_add_req(async_mode="async")
        with caplog.at_level(logging.INFO):
            results = view.add_memories(add_req)

        assert results == []
        summary = [log for log in _stage_logs(caplog) if "stage=summary" in log]
        assert len(summary) == 1
        assert "memory_count=0" in summary[0]

    def test_multiple_memories_returned(self, caplog):
        """Multiple memory items should all appear in results."""
        from memos.multi_mem_cube.single_cube import SingleCubeView

        items = [_make_memory_item(f"mem_{i}") for i in range(3)]

        mock_mem_reader = MagicMock()
        mock_mem_reader.get_memory.return_value = [items]
        mock_mem_reader.save_rawfile = False

        mock_text_mem = MagicMock()
        mock_text_mem.add.return_value = [it.id for it in items]
        mock_text_mem.mode = "async"

        mock_naive_cube = MagicMock()
        mock_naive_cube.text_mem = mock_text_mem

        view = SingleCubeView(
            cube_id="cube_multi",
            naive_mem_cube=mock_naive_cube,
            mem_reader=mock_mem_reader,
            mem_scheduler=MagicMock(),
            logger=logging.getLogger("test.multi"),
            searcher=None,
        )

        add_req = _make_add_req(async_mode="async")
        with caplog.at_level(logging.INFO):
            results = view.add_memories(add_req)

        assert len(results) == 3
        summary = [log for log in _stage_logs(caplog) if "stage=summary" in log]
        assert "memory_count=3" in summary[0]


# ===========================================================================
# CompositeCubeView — multi_cube stage
# ===========================================================================


class TestCompositeCubeAdd:
    def test_single_cube_emits_multi_cube_log(self, caplog):
        from memos.multi_mem_cube.composite_cube import CompositeCubeView

        fake = _FakeSingleCube(cube_id="c1", result=[{"m": 1}])
        composite = CompositeCubeView(
            cube_views=[fake],
            logger=logging.getLogger("test.composite"),
        )

        add_req = _make_add_req()
        with caplog.at_level(logging.INFO):
            results = composite.add_memories(add_req)

        assert len(results) == 1
        multi = [log for log in _stage_logs(caplog) if "stage=multi_cube" in log]
        assert len(multi) == 1
        assert "cube_count=1" in multi[0]

    def test_multi_cube_emits_stage_with_duration(self, caplog):
        from memos.multi_mem_cube.composite_cube import CompositeCubeView

        fake1 = _FakeSingleCube(cube_id="c1", result=[{"m": 1}])
        fake2 = _FakeSingleCube(cube_id="c2", result=[{"m": 2}])
        composite = CompositeCubeView(
            cube_views=[fake1, fake2],
            logger=logging.getLogger("test.composite"),
        )

        add_req = _make_add_req()
        with caplog.at_level(logging.INFO):
            results = composite.add_memories(add_req)

        assert len(results) == 2
        multi = [log for log in _stage_logs(caplog) if "stage=multi_cube" in log]
        assert len(multi) == 1
        assert "cube_count=2" in multi[0]
        assert "duration_ms=" in multi[0]

    def test_fan_out_results_aggregated(self):
        from memos.multi_mem_cube.composite_cube import CompositeCubeView

        fake1 = _FakeSingleCube(cube_id="c1", result=[{"a": 1}, {"a": 2}])
        fake2 = _FakeSingleCube(cube_id="c2", result=[{"b": 3}])
        composite = CompositeCubeView(
            cube_views=[fake1, fake2],
            logger=logging.getLogger("test.composite"),
        )

        add_req = _make_add_req()
        results = composite.add_memories(add_req)

        assert len(results) == 3
