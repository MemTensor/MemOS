"""Pure helpers of the PostgreSQL writer: derived columns and experience content."""

from memos.configs.project_memory_limits import LIMITS, count_units
from memos.project_dbs.item import ExperienceCard, JsonPart, Source
from memos.project_dbs.postgres_writer import (
    anchor_keys,
    conversation_ids,
    experience_content,
    merge_sources,
)


def test_merge_sources_one_item_per_conversation():
    existing = [{"conversation_id": "c1", "user_id": ["a"], "agent_id": None, "note": 1}]
    merged = merge_sources(
        existing,
        [
            Source(conversation_id="c1", user_id=["b", "a"]),
            Source(conversation_id="c1", user_id=["c"], agent_id="codex"),  # other agent
            Source(user_id=["a"]),
            Source(user_id=["a"]),  # duplicate without a conversation
            Source(user_id=["b"]),  # other member without a conversation
        ],
    )
    assert merged == [
        {"conversation_id": "c1", "user_id": ["a", "b"], "agent_id": None, "note": 1},
        {"conversation_id": "c1", "user_id": ["c"], "agent_id": "codex"},
        {"conversation_id": None, "user_id": ["a"], "agent_id": None},
        {"conversation_id": None, "user_id": ["b"], "agent_id": None},
    ]


def test_conversation_ids_skip_empty_and_dedupe():
    sources = [
        {"conversation_id": "c2"},
        {"conversation_id": None},
        {"conversation_id": ""},
        {"conversation_id": "c1"},
        {"conversation_id": "c2"},
    ]
    assert conversation_ids(sources) == ["c2", "c1"]


def test_anchor_keys_use_key_or_canonical_json():
    anchors = [
        JsonPart.model_validate({"key": "file:a.py", "line": 3}),
        {"path": "b.py", "kind": "file"},
        {"key": ""},  # empty key: falls back to the JSON form
        {"key": "file:a.py"},  # duplicate
    ]
    assert anchor_keys(anchors) == [
        "file:a.py",
        '{"kind": "file", "path": "b.py"}',
        '{"key": ""}',
    ]


def test_experience_content_joins_card_parts_and_caps_length():
    card = ExperienceCard(task_intent="导出", problem="", principle="先读代码")
    assert experience_content(card) == "导出｜先读代码"
    long = ExperienceCard(task_intent="导" * 300, problem="出" * 300, principle="z")
    assert count_units(experience_content(long)) <= LIMITS.experience
