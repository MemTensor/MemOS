from __future__ import annotations

import argparse
import json
import os
import sys

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SOURCE_LABELS = {
    "issue": "Issue",
    "pr": "PR",
}


class PreflightError(ValueError):
    pass


class YunxiaoApiError(RuntimeError):
    pass


class UrllibTransport:
    def __init__(
        self,
        token: str,
        *,
        base_url: str = "https://openapi-rdc.aliyuncs.com",
        timeout_seconds: int = 30,
    ) -> None:
        self._token = token
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    def __call__(self, method: str, path: str) -> Any:
        request = Request(
            f"{self._base_url}{path}",
            method=method,
            headers={
                "Accept": "application/json",
                "x-yunxiao-token": self._token,
            },
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                payload = response.read().decode()
        except HTTPError as error:
            request_id = error.headers.get("x-request-id", "unknown")
            raise YunxiaoApiError(
                f"云效 API 请求失败：HTTP {error.code}，request_id={request_id}"
            ) from error
        except URLError as error:
            raise YunxiaoApiError(f"无法连接云效 API：{error.reason}") from error

        try:
            return json.loads(payload)
        except json.JSONDecodeError as error:
            raise YunxiaoApiError("云效 API 返回了非 JSON 响应") from error


class YunxiaoClient:
    def __init__(self, transport: Any) -> None:
        self._transport = transport

    def get(self, path: str) -> Any:
        return self._transport("GET", path)


def build_source_key(item_type: str, item: dict[str, Any]) -> str:
    return f"[GitHub {SOURCE_LABELS[item_type]} #{item['number']}]"


def build_title(item_type: str, item: dict[str, Any]) -> str:
    return f"{build_source_key(item_type, item)} {item['title']}"


def iso_after_days(value: str, days: int) -> str:
    created_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    finished_at = created_at + timedelta(days=days)
    return finished_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_create_payload(
    *,
    item_type: str,
    item: dict[str, Any],
    workitem_type_id: str,
    assigned_to: str,
    priority: str,
    status: str,
    project_id: str,
) -> dict[str, str]:
    return {
        "spaceId": project_id,
        "workitemTypeId": workitem_type_id,
        "subject": build_title(item_type, item),
        "description": f"GitHub: {item['html_url']}",
        "status": status,
        "assignedTo": assigned_to,
        "priority": priority,
        "planStartTime": item["created_at"],
        "planFinishTime": iso_after_days(item["created_at"], 7),
    }


def build_status_update_payload(status: str) -> dict[str, str]:
    return {"status": status}


def source_status(item_type: str, item: dict[str, Any]) -> str:
    if item["state"] == "open":
        return "待处理"
    if item_type == "pr" and item.get("merged"):
        return "已完成"
    return "已取消"


def _data(response: Any) -> Any:
    return response.get("data", response) if isinstance(response, dict) else response


def _item_id(item: dict[str, Any]) -> str:
    for key in ("id", "identifier", "organizationId", "userId", "statusId", "value"):
        value = item.get(key)
        if value:
            return str(value)
    raise PreflightError(f"云效对象缺少标识符：{item}")


def _item_name(item: dict[str, Any]) -> str | None:
    for key in ("name", "displayName", "userName", "displayValue", "statusName"):
        value = item.get(key)
        if isinstance(value, str):
            return value
    return None


def _list_data(response: Any, label: str, keys: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    data = _data(response)
    if isinstance(data, dict):
        for key in (*keys, "items"):
            value = data.get(key)
            if isinstance(value, list):
                data = value
                break
    if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
        raise PreflightError(f"云效{label}响应格式不符合预期")
    return data


def _find_by_name(items: list[dict[str, Any]], name: str, label: str) -> dict[str, Any]:
    for item in items:
        if _item_name(item) == name:
            return item
    raise PreflightError(f"未在云效中找到{label}：{name}")


def _project_name(project: Any) -> str | None:
    return _item_name(project) if isinstance(project, dict) else None


def _field_identifier(field: dict[str, Any]) -> str | None:
    for key in ("id", "identifier", "fieldIdentifier", "propertyKey"):
        value = field.get(key)
        if isinstance(value, str):
            return value
    return None


def _field_options(field: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("options", "values", "fieldOptions"):
        value = field.get(key)
        if isinstance(value, list) and all(isinstance(item, dict) for item in value):
            return value
    raise PreflightError("优先级字段没有可用选项")


def preflight(
    client: YunxiaoClient,
    *,
    project_id: str,
    project_name: str,
    assignee_name: str,
    priority_name: str,
) -> dict[str, Any]:
    user = _data(client.get("/oapi/v1/platform/user"))
    if not isinstance(user, dict):
        raise PreflightError("无法通过 PAT 获取云效用户信息")

    organizations = _list_data(client.get("/oapi/v1/platform/organizations"), "组织列表")
    expected_statuses = ("待处理", "已完成", "已取消")

    for organization in organizations:
        organization_id = _item_id(organization)
        project_path = f"/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}"
        project = _data(client.get(project_path))
        if _project_name(project) != project_name:
            continue

        types_path = (
            f"/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}"
            "/workitemTypes?category=Req"
        )
        workitem_types = _list_data(client.get(types_path), "工作项类型", ("workitemTypes",))
        requirement_type = next(
            (
                item
                for item in workitem_types
                if item.get("categoryId", item.get("category")) == "Req"
            ),
            None,
        )
        if requirement_type is None:
            raise PreflightError("目标项目没有需求（Req）工作项类型")
        workitem_type_id = _item_id(requirement_type)

        members_path = (
            f"/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}/members"
        )
        assignee = _find_by_name(
            _list_data(client.get(members_path), "项目成员", ("members",)),
            assignee_name,
            "默认负责人",
        )

        workflow_path = (
            f"/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}"
            f"/workitemTypes/{workitem_type_id}/workflows"
        )
        workflow_items = _list_data(
            client.get(workflow_path), "工作流", ("statuses", "workflowStatuses")
        )
        statuses = {
            status_name: _item_id(_find_by_name(workflow_items, status_name, "工作流状态"))
            for status_name in expected_statuses
        }

        fields_path = (
            f"/oapi/v1/projex/organizations/{organization_id}/projects/{project_id}"
            f"/workitemTypes/{workitem_type_id}/fields"
        )
        fields = _list_data(client.get(fields_path), "工作项字段", ("fields", "fieldConfigs"))
        priority_field = next(
            (field for field in fields if _field_identifier(field) == "priority"), None
        )
        if priority_field is None:
            raise PreflightError("需求工作项缺少优先级字段")
        priority = _find_by_name(_field_options(priority_field), priority_name, "默认优先级")

        return {
            "organization_id": organization_id,
            "project_id": project_id,
            "workitem_type_id": workitem_type_id,
            "assignee_id": _item_id(assignee),
            "priority_id": _item_id(priority),
            "statuses": statuses,
        }

    raise PreflightError(f"未找到项目：{project_name}（{project_id}）")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GitHub Issue/PR 云效同步工具")
    parser.add_argument("--mode", choices=("preflight",), default="preflight")
    parser.add_argument(
        "--project-id",
        default=os.environ.get("YUNXIAO_PROJECT_ID", "2eac3f84ef1a3482535bd0e255"),
    )
    parser.add_argument(
        "--project-name",
        default=os.environ.get("YUNXIAO_PROJECT_NAME", "MemOS开源项目管理"),
    )
    parser.add_argument(
        "--assignee-name",
        default=os.environ.get("YUNXIAO_DEFAULT_ASSIGNEE_NAME", "孙起"),
    )
    parser.add_argument(
        "--priority-name",
        default=os.environ.get("YUNXIAO_DEFAULT_PRIORITY_NAME", "中"),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get("YUNXIAO_TOKEN")
    if not token:
        print("缺少 YUNXIAO_TOKEN 环境变量", file=sys.stderr)
        return 2

    try:
        result = preflight(
            YunxiaoClient(UrllibTransport(token)),
            project_id=args.project_id,
            project_name=args.project_name,
            assignee_name=args.assignee_name,
            priority_name=args.priority_name,
        )
    except (PreflightError, YunxiaoApiError) as error:
        print(str(error), file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
