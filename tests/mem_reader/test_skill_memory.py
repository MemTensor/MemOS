from memos.mem_reader.read_skill_memory.process_skill_memory import (
    _filter_resolvable_skill_updates,
)


def test_filter_resolvable_skill_updates_keeps_new_skills():
    skill_memory = {"name": "New skill", "update": False}

    assert _filter_resolvable_skill_updates([skill_memory], {}) == [skill_memory]


def test_filter_resolvable_skill_updates_keeps_known_updates():
    skill_memory = {"name": "Existing skill", "update": True, "old_memory_id": "skill-1"}

    assert _filter_resolvable_skill_updates([skill_memory], {"skill-1": object()}) == [
        skill_memory
    ]


def test_filter_resolvable_skill_updates_skips_unknown_updates():
    skill_memory = {"name": "Missing skill", "update": True, "old_memory_id": "missing"}

    assert _filter_resolvable_skill_updates([skill_memory], {}) == []
