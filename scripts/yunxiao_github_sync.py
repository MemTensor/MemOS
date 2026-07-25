from __future__ import annotations

import argparse
import json
import os
import sys
import time

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SOURCE_LABELS = {"issue": "Issue", "pr": "PR"}
STATUS_LABELS = ("待处理", "设计中", "开发中", "已完成", "已取消")
DEFAULT_PRIORITY_NAME = "中"
REQUIRED_ENV = ("YUNXIAO_PROJECT_ID", "YUNXIAO_PROJECT_NAME", "YUNXIAO_DEFAULT_ASSIGNEE_NAME")

# ---------- errors ----------


class PreflightError(ValueError):
    pass


class YunxiaoApiError(RuntimeError):
    pass


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise PreflightError(f"缺少必需的环境变量：{name}（请在仓库 Variables 中配置）")
    return value


# ---------- transport ----------


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

    def __call__(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        request = Request(
            f"{self._base_url}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-yunxiao-token": self._token,
            },
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                payload = response.read().decode()
            if not payload.strip():
                return None
            return json.loads(payload)
        except HTTPError as error:
            raise YunxiaoApiError(
                f"云效 API HTTP {error.code}: {error.read().decode(errors='replace')[:300]}"
            ) from error
        except URLError as error:
            raise YunxiaoApiError(f"无法连接云效 API：{error.reason}") from error


# ---------- pure helpers ----------


def build_source_key(item_type: str, item: dict[str, Any]) -> str:
    return f"[GitHub {SOURCE_LABELS[item_type]} #{item['number']}]"


def build_title(item_type: str, item: dict[str, Any]) -> str:
    return f"{build_source_key(item_type, item)} {item['title']}"


def iso_after_days(value: str, days: int) -> str:
    created_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (
        (created_at + timedelta(days=days))
        .astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def source_status(item_type: str, item: dict[str, Any]) -> str:
    if item.get("state") == "open":
        return "待处理"
    if item_type == "pr" and item.get("merged"):
        return "已完成"
    return "已取消"


# ---------- preflight helpers ----------


def _item_id(item: dict[str, Any]) -> str:
    for key in ("id", "identifier", "organizationId", "userId", "statusId", "value"):
        v = item.get(key)
        if v:
            return str(v)
    raise PreflightError(f"云效对象缺少 id：{item}")


def _item_name(item: dict[str, Any]) -> str | None:
    for key in ("name", "displayName", "userName", "displayValue", "statusName"):
        v = item.get(key)
        if isinstance(v, str):
            return v
    return None


def _list_or_extract(payload: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        for k in (*keys, "items"):
            v = payload.get(k)
            if isinstance(v, list) and all(isinstance(x, dict) for x in v):
                return v
    if isinstance(payload, list) and all(isinstance(x, dict) for x in payload):
        return payload
    return []


def _find_by_name(items: list[dict[str, Any]], name: str, label: str) -> dict[str, Any]:
    for item in items:
        if _item_name(item) == name:
            return item
    raise PreflightError(f"未在云效中找到{label}：{name}")


# ---------- preflight ----------


def preflight(
    org: str,
    project_id: str,
    project_name: str,
    assignee_name: str,
    client: YunxiaoClient,
) -> dict[str, Any]:
    organizations = _list_or_extract(client.get("/oapi/v1/platform/organizations"), ())
    if not organizations:
        raise PreflightError("PAT 无法访问任何云效组织")

    for org_data in organizations:
        org_id = _item_id(org_data)
        project = client.get(f"/oapi/v1/projex/organizations/{org_id}/projects/{project_id}")
        if isinstance(project, dict) and project.get("name") == project_name:
            org = org_id
            break
    else:
        raise PreflightError(f"未找到项目：{project_name}（{project_id}）")

    types = _list_or_extract(
        client.get(
            f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/workitemTypes?category=Req"
        ),
        ("workitemTypes",),
    )
    req_type = next((t for t in types if t.get("categoryId", t.get("category")) == "Req"), None)
    if not req_type:
        raise PreflightError("目标项目没有需求（Req）工作项类型")
    type_id = _item_id(req_type)

    members = _list_or_extract(
        client.get(f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/members"),
        ("members",),
    )
    assignee = _find_by_name(members, assignee_name, "默认负责人")

    workflow = _list_or_extract(
        client.get(
            f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/workitemTypes/{type_id}/workflows"
        ),
        ("statuses", "workflowStatuses"),
    )
    statuses = {n: _item_id(_find_by_name(workflow, n, "工作流状态")) for n in STATUS_LABELS}

    fields = _list_or_extract(
        client.get(
            f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/workitemTypes/{type_id}/fields"
        ),
        ("fields", "fieldConfigs"),
    )
    pf = next(
        (
            f
            for f in fields
            if f.get("id") == "priority"
            or f.get("identifier") == "priority"
            or f.get("fieldIdentifier") == "priority"
        ),
        None,
    )
    if not pf:
        raise PreflightError("需求工作项缺少优先级字段")
    opts = _list_or_extract(pf.get("options") or pf.get("values") or {}, ())
    if not opts:
        opts = pf.get("options") or pf.get("values") or []
    priority = _find_by_name(opts, DEFAULT_PRIORITY_NAME, "默认优先级")

    return {
        "org": org,
        "project_id": project_id,
        "type_id": type_id,
        "assignee_id": _item_id(assignee),
        "priority_id": _item_id(priority),
        "statuses": statuses,
    }


# ---------- labels ----------


def sync_labels(
    org: str, project_id: str, wanted: set[str], client: YunxiaoClient
) -> dict[str, str]:
    """Ensure every name in *wanted* has a label; return {name: id}."""
    existing_raw = client.get(f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/labels")
    existing_names: set[str] = set()
    name_to_id: dict[str, str] = {}
    for lbl in _list_or_extract(existing_raw, ()):
        n = _item_name(lbl) or lbl.get("name", "")
        if n:
            existing_names.add(n)
            name_to_id[n] = _item_id(lbl)
    colors = [
        "#e91e63",
        "#9c27b0",
        "#673ab7",
        "#3f51b5",
        "#2196f3",
        "#00bcd4",
        "#009688",
        "#4caf50",
        "#8bc34a",
        "#cddc39",
        "#ffc107",
        "#ff9800",
        "#ff5722",
    ]
    for i, name in enumerate(sorted(wanted - existing_names)):
        try:
            resp = client._transport(
                "POST",
                f"/oapi/v1/projex/organizations/{org}/projects/{project_id}/labels",
                {"name": name, "color": colors[i % len(colors)]},
            )
            name_to_id[name] = _item_id(resp)
            time.sleep(0.1)
        except YunxiaoApiError:
            pass
    return name_to_id


# ---------- search ----------


def find_workitem(org: str, project_id: str, prefix: str, client: YunxiaoClient) -> str | None:
    conditions = json.dumps(
        {
            "conditionGroups": [
                [
                    {
                        "fieldIdentifier": "subject",
                        "operator": "CONTAINS",
                        "value": [prefix],
                        "className": "string",
                        "format": "input",
                    }
                ]
            ]
        },
        ensure_ascii=False,
    )
    resp = client._transport(
        "POST",
        f"/oapi/v1/projex/organizations/{org}/workitems:search",
        {"spaceId": project_id, "category": "Req", "conditions": conditions},
    )
    data = (
        resp
        if isinstance(resp, list)
        else (resp or {}).get("data", resp)
        if isinstance(resp, dict)
        else resp
    )
    items = (
        (data.get("workitems", data.get("items", [])) if isinstance(data, dict) else data)
        if data
        else []
    )
    return _item_id(items[0]) if items else None


# ---------- sync one ----------


def sync_one(
    org: str,
    cfg: dict[str, Any],
    item_type: str,
    item: dict[str, Any],
    *,
    apply: bool,
    label_ids: dict[str, str] | None,
    client: YunxiaoClient,
) -> str:
    source_key = build_source_key(item_type, item)
    existing_id = find_workitem(org, cfg["project_id"], source_key, client)

    if existing_id:
        if item.get("state") == "open":
            return "skipped-open"
        if not apply:
            return "dry-run-status"
        status_name = source_status(item_type, item)
        status_id = cfg["statuses"][status_name]
        client._transport(
            "PUT",
            f"/oapi/v1/projex/organizations/{org}/workitems/{existing_id}",
            {"status": status_id},
        )
        return "updated-status"
    else:
        if item.get("state") != "open":
            return "skipped-closed"
        if not apply:
            return "dry-run-create"
        status_id = cfg["statuses"]["待处理"]
        payload: dict[str, Any] = {
            "spaceId": cfg["project_id"],
            "workitemTypeId": cfg["type_id"],
            "subject": build_title(item_type, item),
            "description": f"GitHub: {item['html_url']}",
            "status": status_id,
            "assignedTo": cfg["assignee_id"],
            "priority": cfg["priority_id"],
            "planStartTime": item["created_at"],
            "planFinishTime": iso_after_days(item["created_at"], 7),
        }
        # labels
        github_labels = [label["name"] for label in item.get("labels", [])]
        lids = [label_ids[n] for n in github_labels if n in label_ids] if label_ids else []
        if lids:
            payload["labels"] = lids
        client._transport("POST", f"/oapi/v1/projex/organizations/{org}/workitems", payload)
        return "created"


# ---------- event ----------


def handle_event(client: YunxiaoClient) -> int:
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        print("缺少 GITHUB_EVENT_PATH", file=sys.stderr)
        return 2
    with open(event_path) as f:
        event = json.load(f)
    action = event.get("action", "")
    if action not in ("opened", "closed", "reopened"):
        print(f"忽略事件 action={action}", file=sys.stderr)
        return 0
    item = event.get("issue") or event.get("pull_request")
    if not item:
        print("事件中缺少 issue/pull_request", file=sys.stderr)
        return 1
    # Determine type
    if event.get("issue") and "pull_request" in event["issue"]:
        # Some issue events carry pr metadata; skip these (they come via pull_request_target separately)
        print("issue 事件包含 PR 元数据，跳过", file=sys.stderr)
        return 0
    item_type = "pr" if "pull_request" in event else "issue"
    if item_type == "pr" and action == "closed":
        item["merged"] = item.get("merged") or event.get("pull_request", {}).get("merged", False)

    cfg = preflight(
        "",
        _required_env("YUNXIAO_PROJECT_ID"),
        _required_env("YUNXIAO_PROJECT_NAME"),
        _required_env("YUNXIAO_DEFAULT_ASSIGNEE_NAME"),
        client,
    )
    org = cfg["org"]
    all_labels = {label["name"] for label in item.get("labels", [])}
    label_ids = sync_labels(org, cfg["project_id"], all_labels, client) if all_labels else {}
    result = sync_one(org, cfg, item_type, item, apply=True, label_ids=label_ids, client=client)
    print(f"{item_type} #{item['number']}: {result}")
    return 0


# ---------- backfill ----------


def backfill(client: YunxiaoClient, *, apply: bool) -> int:
    import urllib.request as ur

    github_token = os.environ.get("GH_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "MemTensor/MemOS")
    hdrs = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {github_token}"}

    def gh(path: str) -> Any:
        req = ur.Request(f"https://api.github.com/repos/{repo}/{path}", headers=hdrs)
        with ur.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())

    issues_raw = gh("issues?state=open&per_page=100&sort=created&direction=desc")
    prs_raw = gh("pulls?state=open&per_page=100&sort=created&direction=desc")

    issues = [x for x in issues_raw if "pull_request" not in x]
    prs = list(prs_raw)
    print(f"GitHub: {len(issues)} open issues, {len(prs)} open PRs", file=sys.stderr)

    cfg = preflight(
        "",
        _required_env("YUNXIAO_PROJECT_ID"),
        _required_env("YUNXIAO_PROJECT_NAME"),
        _required_env("YUNXIAO_DEFAULT_ASSIGNEE_NAME"),
        client,
    )
    org = cfg["org"]

    all_labels: set[str] = set()
    for item in issues + prs:
        all_labels.update(label["name"] for label in item.get("labels", []))
    label_ids = sync_labels(org, cfg["project_id"], all_labels, client) if all_labels else {}

    summary: dict[str, Any] = {}
    for kind, items_list, bucket in (("issue", issues, "issues"), ("pr", prs, "prs")):
        stats = {"source": len(items_list), "created": 0, "skipped": 0, "updated": 0, "failed": 0}
        for item in items_list:
            try:
                r = sync_one(org, cfg, kind, item, apply=apply, label_ids=label_ids, client=client)
                if r.startswith("dry-run"):
                    stats["skipped"] += 1
                elif r == "created":
                    stats["created"] += 1
                elif r == "updated-status":
                    stats["updated"] += 1
                else:
                    stats["skipped"] += 1
            except (YunxiaoApiError, PreflightError, OSError) as e:
                stats["failed"] += 1
                print(f"failed {kind} #{item['number']}: {e}", file=sys.stderr)
            time.sleep(0.12)
        summary[bucket] = stats

    print(json.dumps(summary, ensure_ascii=False))
    return 0 if all(s["failed"] == 0 for s in summary.values()) else 1


# ---------- CLI ----------


class YunxiaoClient:
    def __init__(self, transport: Any) -> None:
        self._transport = transport

    def get(self, path: str) -> Any:
        return self._transport("GET", path)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GitHub → 云效 同步")
    p.add_argument("--mode", choices=("preflight", "event", "backfill"), default="preflight")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get("YUNXIAO_TOKEN")
    if not token:
        print("缺少 YUNXIAO_TOKEN", file=sys.stderr)
        return 2
    transport = UrllibTransport(token)
    client = YunxiaoClient(transport)

    if args.mode == "event":
        return handle_event(client)
    if args.mode == "backfill":
        return backfill(client, apply=args.apply and not args.dry_run)

    try:
        result = preflight(
            "",
            _required_env("YUNXIAO_PROJECT_ID"),
            _required_env("YUNXIAO_PROJECT_NAME"),
            _required_env("YUNXIAO_DEFAULT_ASSIGNEE_NAME"),
            client,
        )
    except (PreflightError, YunxiaoApiError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "org": result["org"],
                "project_id": result["project_id"],
                "type_id": result["type_id"],
                "assignee_id": result["assignee_id"],
                "priority_id": result["priority_id"],
                "statuses": result["statuses"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
