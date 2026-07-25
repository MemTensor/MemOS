from __future__ import annotations

import importlib.util

from pathlib import Path
from typing import Any


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "yunxiao_github_sync.py"
SPEC = importlib.util.spec_from_file_location("yunxiao_github_sync", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_build_title_and_key() -> None:
    item = {"number": 42, "title": "Fix scheduler", "created_at": "2026-07-25T01:02:03Z"}
    assert MODULE.build_source_key("issue", item) == "[GitHub Issue #42]"
    assert MODULE.build_title("issue", item) == "[GitHub Issue #42] Fix scheduler"


def test_iso_after_days() -> None:
    assert MODULE.iso_after_days("2026-07-25T01:02:03Z", 7) == "2026-08-01T01:02:03Z"


def test_source_status() -> None:
    assert MODULE.source_status("issue", {"state": "open"}) == "待响应"
    assert MODULE.source_status("pr", {"state": "closed", "merged": True}) == "已完成"
    assert MODULE.source_status("pr", {"state": "closed", "merged": False}) == "已关闭"
    assert MODULE.source_status("issue", {"state": "closed"}) == "已关闭"


def test_preflight_documented_schema() -> None:
    calls: list[tuple[str, str]] = []
    responses = {
        "GET /oapi/v1/platform/organizations": [
            {"organizationId": "org-id", "name": "MemTensor"},
        ],
        "GET /oapi/v1/projex/organizations/org-id/projects/project-id": {
            "id": "project-id",
            "name": "MemOS开源项目管理",
        },
        "GET /oapi/v1/projex/organizations/org-id/projects/project-id/workitemTypes?category=Req": [
            {"id": "req-id", "categoryId": "Req", "name": "需求"},
        ],
        "GET /oapi/v1/projex/organizations/org-id/projects/project-id/members": [
            {"userId": "sunqi-id", "userName": "孙起"},
        ],
        "GET /oapi/v1/projex/organizations/org-id/projects/project-id/workitemTypes/req-id/workflows": {
            "statuses": [
                {"statusId": "pending-id", "displayValue": "待响应"},
                {"statusId": "in-progress-id", "displayValue": "处理中"},
                {"statusId": "verify-id", "displayValue": "待验证"},
                {"statusId": "done-id", "displayValue": "已完成"},
                {"statusId": "closed-id", "displayValue": "已关闭"},
                {"statusId": "wontfix-id", "displayValue": "不予处理"},
            ],
        },
        "GET /oapi/v1/projex/organizations/org-id/projects/project-id/workitemTypes/req-id/fields": [
            {"id": "priority", "options": [{"id": "medium-id", "displayValue": "中"}]},
        ],
    }

    def transport(method: str, path: str, body: object = None) -> object:
        calls.append((method, path))
        return responses[f"{method} {path}"]

    result = MODULE.preflight(
        "",
        "project-id",
        "MemOS开源项目管理",
        "孙起",
        "中",
        MODULE.YunxiaoClient(transport),
    )
    assert result == {
        "org": "org-id",
        "project_id": "project-id",
        "type_id": "req-id",
        "assignee_id": "sunqi-id",
        "priority_id": "medium-id",
        "statuses": {
            "待响应": "pending-id",
            "处理中": "in-progress-id",
            "待验证": "verify-id",
            "已完成": "done-id",
            "已关闭": "closed-id",
            "不予处理": "wontfix-id",
        },
    }
    assert {m for m, _ in calls} == {"GET"}


def test_sync_one_create() -> None:
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def transport(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        calls.append((method, path, body))
        if "search" in path:
            return {"data": {"workitems": []}}
        if method == "POST":
            return {"id": "new-id"}
        raise AssertionError(f"unexpected {method} {path}")

    cfg = {
        "org": "org",
        "project_id": "p",
        "type_id": "t",
        "assignee_id": "a",
        "priority_id": "pr",
        "statuses": {
            "待响应": "s1",
            "处理中": "s2",
            "待验证": "s3",
            "已完成": "s4",
            "已关闭": "s5",
            "不予处理": "s6",
        },
    }
    item = {
        "number": 1,
        "title": "Test",
        "html_url": "https://g.com",
        "created_at": "2026-07-25T01:02:03Z",
        "state": "open",
        "labels": [{"name": "bug"}],
    }
    r = MODULE.sync_one(
        "org",
        cfg,
        "issue",
        item,
        apply=True,
        label_ids={"bug": "lid1"},
        client=MODULE.YunxiaoClient(transport),
    )
    assert r == "created"
    assert calls[1][2] is not None
    assert calls[1][2]["labels"] == ["lid1"]


def test_sync_one_close_updates_status() -> None:
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def transport(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        calls.append((method, path, body))
        if "search" in path:
            return {"data": {"workitems": [{"id": "existing"}]}}
        return {}

    cfg = {
        "org": "org",
        "project_id": "p",
        "type_id": "t",
        "assignee_id": "a",
        "priority_id": "pr",
        "statuses": {
            "待响应": "s1",
            "处理中": "s2",
            "待验证": "s3",
            "已完成": "s4",
            "已关闭": "s5",
            "不予处理": "s6",
        },
    }
    r = MODULE.sync_one(
        "org",
        cfg,
        "issue",
        {
            "number": 1,
            "title": "T",
            "html_url": "x",
            "state": "closed",
            "created_at": "2026-07-25T01:02:03Z",
            "labels": [],
        },
        apply=True,
        label_ids={},
        client=MODULE.YunxiaoClient(transport),
    )
    assert r == "updated-status"
    assert calls[1][2] == {"status": "s5"}


def test_workflow_structure() -> None:
    content = (
        Path(__file__).parents[1] / ".github" / "workflows" / "yunxiao-github-sync.yml"
    ).read_text(encoding="utf-8")
    assert "pull_request_target:" in content
    assert "issues:" in content
    assert "workflow_dispatch:" in content
    assert "YUNXIAO_TOKEN: ${{ secrets.YUNXIAO_TOKEN }}" in content
    assert "--mode event" in content
    assert "mode:" in content
    assert "preflight" in content
    assert "backfill" in content
    assert "contents: read" in content
    assert "checkout@v4" in content
