from __future__ import annotations

import importlib.util

from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "yunxiao_github_sync.py"
SPEC = importlib.util.spec_from_file_location("yunxiao_github_sync", MODULE_PATH)
assert SPEC is not None
assert SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_build_title_and_key_for_issue() -> None:
    item = {
        "number": 42,
        "title": "Fix scheduler",
        "created_at": "2026-07-25T01:02:03Z",
    }

    assert MODULE.build_source_key("issue", item) == "[GitHub Issue #42]"
    assert MODULE.build_title("issue", item) == "[GitHub Issue #42] Fix scheduler"


def test_build_create_payload_sets_sla_and_only_allowed_fields() -> None:
    item = {
        "number": 42,
        "title": "Fix scheduler",
        "html_url": "https://github.com/MemTensor/MemOS/issues/42",
        "created_at": "2026-07-25T01:02:03Z",
    }

    payload = MODULE.build_create_payload(
        item_type="issue",
        item=item,
        workitem_type_id="req-id",
        assigned_to="sunqi-id",
        priority="medium-id",
        status="pending-id",
        project_id="project-id",
    )

    assert payload["assignedTo"] == "sunqi-id"
    assert payload["priority"] == "medium-id"
    assert payload["planStartTime"] == "2026-07-25T01:02:03Z"
    assert payload["planFinishTime"] == "2026-08-01T01:02:03Z"
    assert payload["subject"] == "[GitHub Issue #42] Fix scheduler"
    assert payload["description"] == "GitHub: https://github.com/MemTensor/MemOS/issues/42"
    assert set(payload).isdisjoint({"creator", "comments", "labels"})


def test_build_status_update_payload_only_contains_status() -> None:
    assert MODULE.build_status_update_payload("done-id") == {"status": "done-id"}


def test_map_pr_closed_status_distinguishes_merged() -> None:
    assert MODULE.source_status("pr", {"state": "closed", "merged": True}) == "已完成"
    assert MODULE.source_status("pr", {"state": "closed", "merged": False}) == "已取消"


def test_preflight_handles_documented_raw_response_shapes() -> None:
    calls: list[tuple[str, str]] = []
    responses = {
        "GET /oapi/v1/platform/user": {"userId": "sync-user", "userName": "孙起"},
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
                {"statusId": "pending-id", "displayValue": "待处理"},
                {"statusId": "done-id", "displayValue": "已完成"},
                {"statusId": "cancelled-id", "displayValue": "已取消"},
            ],
        },
        "GET /oapi/v1/projex/organizations/org-id/projects/project-id/workitemTypes/req-id/fields": [
            {
                "id": "priority",
                "options": [{"id": "medium-id", "displayValue": "中"}],
            },
        ],
    }

    def transport(method: str, path: str) -> object:
        calls.append((method, path))
        return responses[f"{method} {path}"]

    result = MODULE.preflight(
        MODULE.YunxiaoClient(transport),
        project_id="project-id",
        project_name="MemOS开源项目管理",
        assignee_name="孙起",
        priority_name="中",
    )

    assert result == {
        "organization_id": "org-id",
        "project_id": "project-id",
        "workitem_type_id": "req-id",
        "assignee_id": "sunqi-id",
        "priority_id": "medium-id",
        "statuses": {
            "待处理": "pending-id",
            "已完成": "done-id",
            "已取消": "cancelled-id",
        },
    }
    assert {method for method, _ in calls} == {"GET"}


def test_preflight_workflow_only_runs_read_only_preflight() -> None:
    workflow = Path(__file__).parents[1] / ".github" / "workflows" / "yunxiao-github-sync.yml"
    content = workflow.read_text(encoding="utf-8")

    assert "workflow_dispatch:" in content
    assert "YUNXIAO_TOKEN: ${{ secrets.YUNXIAO_TOKEN }}" in content
    assert "--mode preflight" in content
    assert "YUNXIAO_PROJECT_ID: 2eac3f84ef1a3482535bd0e255" in content
    assert "issues:" not in content
    assert "pull_request" not in content
    assert "--apply" not in content
