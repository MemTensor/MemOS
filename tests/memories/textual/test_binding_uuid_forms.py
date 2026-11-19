"""Binding identity is UUID identity, including mixed accepted spellings."""

from uuid import UUID, uuid4

import pytest

from memos.memories.textual.tree_text_memory.organize.manager import extract_working_binding_ids


VALUE = UUID("a1234567-1234-5678-9abc-123456789abc")
FORMS = [str(VALUE), VALUE.hex, VALUE.urn, "{" + str(VALUE) + "}", str(VALUE).upper()]


@pytest.mark.parametrize("primary", FORMS)
@pytest.mark.parametrize("binding", FORMS)
def test_same_uuid_never_becomes_cleanup_candidate(primary, binding):
    assert (
        extract_working_binding_ids([{"id": primary, "metadata": {"working_binding": binding}}])
        == set()
    )


@pytest.mark.parametrize("primary", [None, 42, "legacy-id", str(uuid4())])
def test_independent_binding_preserves_its_storage_key(primary):
    binding = VALUE.urn
    assert extract_working_binding_ids(
        [{"id": primary, "metadata": {"working_binding": binding}}]
    ) == {binding}
