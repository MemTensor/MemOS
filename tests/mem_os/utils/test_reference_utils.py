"""
Regression tests for ``prepare_reference_data``.

Related issue: https://github.com/MemTensor/MemOS/issues/2448

The dict branch of ``prepare_reference_data`` used to assume that every dict
carried an ``id`` key and that the ``id`` was always a string. Both
assumptions are false for already-serialized memory payloads (cached search
results, MCP messages, etc.) and led to ``KeyError`` / ``AttributeError``
escaping the streaming pipeline. These tests pin the normalized behavior in
place so the regression cannot come back.
"""

import uuid

import pytest

from memos.mem_os.utils.reference_utils import prepare_reference_data
from memos.memories.textual.item import TextualMemoryItem


class TestPrepareReferenceDataDictEntries:
    """Dict entries should be normalized safely, never raise."""

    def test_missing_id_does_not_raise_keyerror(self):
        """Repro from #2448: dict entry without ``id`` used to raise KeyError."""
        entry = {"metadata": {"memory": "m"}}

        result = prepare_reference_data([entry])

        assert len(result) == 1
        metadata = result[0]["metadata"]
        # Missing id → ref_id derivation skipped; id slot preserved as None.
        assert metadata["ref_id"] == ""
        assert metadata["id"] is None
        # Metadata bookkeeping still populated.
        assert metadata["embedding"] == []
        assert metadata["sources"] == []

    def test_non_string_id_is_stringified(self):
        """Repro from #2448: int id used to raise AttributeError on .split."""
        entry = {"id": 12345, "memory": "m", "metadata": {}}

        result = prepare_reference_data([entry])

        assert len(result) == 1
        metadata = result[0]["metadata"]
        # ``.split("-")[0]`` on ``str(12345)`` == "12345".
        assert metadata["ref_id"] == "12345"
        # Original id value round-trips unchanged into metadata["id"].
        assert metadata["id"] == 12345
        assert metadata["memory"] == "m"

    def test_uuid_object_id_is_stringified(self):
        """UUID objects (another non-string id shape) must also be tolerated."""
        raw_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
        entry = {"id": raw_id, "memory": "m", "metadata": {}}

        result = prepare_reference_data([entry])

        metadata = result[0]["metadata"]
        assert metadata["ref_id"] == "12345678"
        assert metadata["id"] == raw_id

    def test_string_id_still_derives_prefix(self):
        """Baseline: a well-formed dict entry keeps the pre-fix behavior."""
        entry = {
            "id": "abcdef12-3456-7890-abcd-ef1234567890",
            "memory": "hello",
            "metadata": {"source": "x"},
        }

        result = prepare_reference_data([entry])

        metadata = result[0]["metadata"]
        assert metadata["ref_id"] == "abcdef12"
        assert metadata["id"] == "abcdef12-3456-7890-abcd-ef1234567890"
        assert metadata["memory"] == "hello"
        assert metadata["source"] == "x"
        assert metadata["embedding"] == []
        assert metadata["sources"] == []

    def test_missing_metadata_dict_is_auto_created(self):
        """A dict entry lacking metadata must not blow up on ["metadata"]["ref_id"] = ..."""
        entry = {"id": "abcdef12-1111-2222-3333-444455556666", "memory": "m"}

        result = prepare_reference_data([entry])

        metadata = result[0]["metadata"]
        assert metadata["ref_id"] == "abcdef12"
        assert metadata["id"] == "abcdef12-1111-2222-3333-444455556666"
        assert metadata["memory"] == "m"
        assert metadata["embedding"] == []
        assert metadata["sources"] == []

    def test_missing_memory_falls_back_to_none(self):
        """Missing memory key should not raise, just fall through as None."""
        entry = {"id": "abcdef12-aaaa-bbbb-cccc-ddddeeeeffff", "metadata": {}}

        result = prepare_reference_data([entry])

        metadata = result[0]["metadata"]
        assert metadata["memory"] is None
        assert metadata["ref_id"] == "abcdef12"

    def test_caller_dict_is_not_mutated(self):
        """The dict branch must not mutate the caller's entry or its metadata.

        Regression guard: earlier versions did
        ``memories_json = memories`` (alias, not copy) and then wrote
        ``metadata["ref_id"] = ...``. If a caller cached the payload or reused
        it across MCP calls, those side-effects would silently corrupt it.
        """
        original_metadata = {"source": "cache"}
        entry = {
            "id": "abcdef12-3456-7890-abcd-ef1234567890",
            "memory": "hello",
            "metadata": original_metadata,
        }
        # Snapshot the caller-visible shape so we can compare after the call.
        entry_snapshot = {
            "id": entry["id"],
            "memory": entry["memory"],
            "metadata": dict(original_metadata),
        }

        prepare_reference_data([entry])

        # Caller's outer dict unchanged (no injected ref_id/embedding/sources/id).
        assert entry == entry_snapshot
        # Caller's inner metadata dict unchanged (same object, same keys).
        assert entry["metadata"] is original_metadata
        assert original_metadata == {"source": "cache"}


class TestPrepareReferenceDataTextualMemoryItem:
    """The TextualMemoryItem branch keeps its original contract."""

    def test_textual_memory_item_branch_unchanged(self):
        item = TextualMemoryItem(
            id="abcdef12-3456-7890-abcd-ef1234567890",
            memory="hello world",
        )

        result = prepare_reference_data([item])

        metadata = result[0]["metadata"]
        assert metadata["ref_id"] == "abcdef12"
        assert metadata["id"] == "abcdef12-3456-7890-abcd-ef1234567890"
        assert metadata["memory"] == "hello world"
        assert metadata["embedding"] == []
        assert metadata["sources"] == []


class TestPrepareReferenceDataOldBehaviorDemonstration:
    """
    Pre-fix demonstration tests kept for auditability.

    These document the exact error signatures reported in #2448 and are
    xfailed (strict=False) so they do NOT gate CI — after the fix the call
    returns normally and pytest reports XPASS (non-fatal); if the fix is ever
    reverted the call raises again and pytest reports XFAIL, again non-fatal.
    Either way the ``TestPrepareReferenceDataDictEntries`` cases above are
    the hard gate: they will fail loudly if the fix is reverted.
    """

    @pytest.mark.parametrize(
        "entry",
        [
            {"metadata": {"memory": "m"}},  # missing id
            {"id": 12345, "memory": "m", "metadata": {}},  # int id
        ],
    )
    @pytest.mark.xfail(
        strict=False,
        reason=(
            "Documents pre-fix error signatures from #2448. Passes after the "
            "fix (XPASS, strict=False so it does not gate CI); if the fix is "
            "ever reverted the call will raise again and this test will XFAIL."
        ),
    )
    def test_pre_fix_would_have_raised(self, entry):
        """Before the fix, both cases raised. After the fix, both succeed."""
        # After the fix this returns normally; the test simply verifies the
        # call no longer raises the two exceptions from the issue.
        result = prepare_reference_data([entry])
        assert isinstance(result, list) and len(result) == 1
