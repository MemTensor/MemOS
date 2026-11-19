from __future__ import annotations

import json
import sqlite3

from memos.project_memory.add_legacy import LegacyArchive, read_legacy_sqlite
from memos.project_memory.types import PROJECT_EXPERIENCE, PROJECT_MESSAGE, PROJECT_TASK


def test_readonly_legacy_sqlite(tmp_path):
    path = tmp_path / "source.sqlite"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE memory (id TEXT, properties TEXT, seq INTEGER)")
        connection.execute(
            "INSERT INTO memory VALUES ('source-node', ?, 1)",
            (json.dumps({"memory": "source content", "memory_type": PROJECT_MESSAGE}),),
        )
    original = path.read_bytes()
    assert read_legacy_sqlite(path)[0]["memory"] == "source content"
    assert path.read_bytes() == original


def test_archive_scope_and_permissions(tmp_path):
    rows = [
        {
            "id": "experience",
            "memory": "old card",
            "metadata": {
                "memory_type": PROJECT_EXPERIENCE,
                "user_name": "space-a",
                "info": {"task_intent": "old card"},
                "status": "activated",
            },
        },
        {
            "id": "task",
            "memory": "completed",
            "metadata": {
                "memory_type": PROJECT_TASK,
                "task_id": "task",
                "space_ids": ["space-a"],
                "user_id": "user",
                "status": "completed",
                "memory_ids": ["old-topic"],
            },
        },
    ]
    path = tmp_path / "archive.json"
    archive = LegacyArchive("project-a", rows, {"space-a": "project-a"}, {"experience"})
    archive.write(path)
    restored = LegacyArchive.read(path, "project-a")
    assert path.stat().st_mode & 0o077 == 0
    assert restored.digest == archive.digest
    assert restored.get_experience("experience", "space-a").task_intent == "old card"
    assert restored.get_experience("experience", "space-b") is None
    assert restored.find_node("task") is None
    assert restored.task_status("task", "other", lambda _space: True, set()) is None
    assert restored.task_status("task", "user", lambda _space: False, set()) is None
    status = restored.task_status("task", "user", lambda _space: True, set())
    assert status["memory_views"]["project"]["memory_ids"] == []
