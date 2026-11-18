"""Run a disposable, local-only MemMate recall evaluation.

This runner deliberately targets loopback only and creates a unique namespace for
one synthetic memory.  It waits for asynchronous processing, verifies recall,
deletes the memory, and verifies both direct lookup and marker absence from a
follow-up search.  It never reads or writes the default namespace and refuses
non-loopback URLs so it cannot be pointed at a cloud or production service by
accident.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import uuid

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


REPORT_SCHEMA_VERSION = "memos-local-isolated-eval.v1"
DEFAULT_URL = "http://127.0.0.1:19760"
DEFAULT_TOKEN_ENV = "MEMMY_MEMORY_TOKEN"
DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_POLL_SECONDS = 2.0
TERMINAL_STATES = {"ready", "ready_text_only", "failed"}
PENDING_STATES = {"summary_pending", "summarizing", "embedding_pending", "embedding"}


class LocalEvalError(RuntimeError):
    """Raised when the local evaluation cannot safely complete."""


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _validate_local_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise LocalEvalError("local evaluation target must be a loopback http(s) URL")
    if (
        parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise LocalEvalError(
            "local evaluation base URL must not contain path, query, fragment, or credentials"
        )
    return base_url.rstrip("/")


def _request(
    base_url: str,
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[int, dict[str, Any]]:
    encoded = None if body is None else _canonical(body)
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    if encoded is not None:
        headers["Content-Type"] = "application/json"
    request = Request(f"{base_url}{path}", data=encoded, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            payload = json.loads(raw.decode("utf-8")) if raw else {}
            if not isinstance(payload, dict):
                raise LocalEvalError(f"local service returned non-object JSON for {path}")
            return response.status, payload
    except HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw.decode("utf-8", errors="replace")[:512]}
        return exc.code, payload
    except (TimeoutError, OSError, URLError) as exc:
        raise LocalEvalError(f"local service request failed for {path}: {exc}") from exc


def _namespace(run_id: str) -> dict[str, str]:
    return {
        "userId": "quality-eval-shadow",
        "tenantId": "quality-eval-local",
        "projectId": run_id,
        "workspaceId": run_id,
        "workspacePath": f"/tmp/{run_id}",
        "source": "quality-eval-shadow",
        "profileId": run_id,
        "profileLabel": "isolated synthetic evaluation",
        "sessionKey": run_id,
    }


def _hits(payload: dict[str, Any]) -> list[dict[str, Any]]:
    debug = payload.get("debug")
    hits = debug.get("hits") if isinstance(debug, dict) else None
    return [item for item in hits if isinstance(item, dict)] if isinstance(hits, list) else []


def _hit_ids(payload: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for hit in _hits(payload):
        if isinstance(hit.get("id"), str):
            ids.add(hit["id"])
        members = hit.get("members")
        if isinstance(members, list):
            for member in members:
                if isinstance(member, dict) and isinstance(member.get("id"), str):
                    ids.add(member["id"])
    return ids


def run_local_isolated_evaluation(
    *,
    base_url: str = DEFAULT_URL,
    token_env: str = DEFAULT_TOKEN_ENV,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Execute the disposable add -> process -> search -> delete -> verify flow."""

    base_url = _validate_local_url(base_url)
    token = os.environ.get(token_env, "").strip()
    if not token:
        raise LocalEvalError(f"missing local MemMate token environment variable: {token_env}")
    if timeout_seconds <= 0 or poll_seconds <= 0:
        raise LocalEvalError("timeout and poll intervals must be positive")
    run_id = run_id or f"memos-local-eval-{uuid.uuid4().hex[:12]}"
    namespace = _namespace(run_id)
    content = (
        f"Quality evaluation synthetic marker {run_id}: isolated local memory recall fixture. "
        "Delete after test."
    )
    query = "isolated local memory recall fixture"
    content_hash = _sha256(content.encode())
    started_at = _utc_now()
    started_clock = time.monotonic()
    memory_id: str | None = None
    steps: dict[str, Any] = {}
    cleanup_attempted = False
    cleanup_error: str | None = None
    service_health: dict[str, Any] = {}

    health_status, health = _request(base_url, token, "GET", "/api/v1/health")
    steps["health"] = {
        "httpStatus": health_status,
        "ok": health_status == 200 and health.get("ok") is True,
    }
    if health_status != 200 or health.get("ok") is not True:
        raise LocalEvalError(f"local MemMate health check failed: HTTP {health_status}")
    service_health = {
        "serviceVersion": health.get("serviceVersion"),
        "protocolVersion": health.get("protocolVersion"),
        "storage": {
            "backendId": health.get("storage", {}).get("backendId"),
            "schemaVersion": health.get("storage", {}).get("schemaVersion"),
            "ready": health.get("storage", {}).get("ready"),
        },
    }

    common = {
        "adapterId": "memos-quality-eval-local",
        "namespace": namespace,
        "source": namespace["source"],
    }
    try:
        pre_status, pre = _request(
            base_url,
            token,
            "POST",
            "/api/v1/memory/search",
            {
                **common,
                "requestId": f"{run_id}-pre-search",
                "query": f"{query} {run_id}",
                "limit": 20,
                "includeInjectedContext": False,
                "verbose": True,
            },
        )
        steps["preSearch"] = {
            "httpStatus": pre_status,
            "hitCount": len(_hits(pre)) if pre_status == 200 else None,
            "markerPresent": run_id in json.dumps(pre, ensure_ascii=False),
        }
        if pre_status != 200 or steps["preSearch"]["markerPresent"]:
            raise LocalEvalError("isolated namespace precondition failed")

        add_status, added = _request(
            base_url,
            token,
            "POST",
            "/api/v1/memory/add",
            {
                **common,
                "requestId": f"{run_id}-add",
                "content": content,
                "title": "isolated evaluation fixture",
                "tags": ["quality-eval-shadow", run_id, "test"],
                "deferProcessing": False,
                "sourceAgentId": "memos-quality-eval-local",
            },
        )
        memory_id = added.get("id") if isinstance(added.get("id"), str) else None
        steps["add"] = {"httpStatus": add_status, "id": memory_id, "status": added.get("status")}
        if add_status != 200 or memory_id is None:
            raise LocalEvalError(f"isolated synthetic memory add failed: HTTP {add_status}")

        deadline = time.monotonic() + timeout_seconds
        status_history: list[dict[str, Any]] = []
        final_processing: dict[str, Any] = {}
        while True:
            status_code, status_payload = _request(
                base_url,
                token,
                "POST",
                "/api/v1/memory/processing/status",
                {"requestId": f"{run_id}-status", "namespace": namespace, "memoryIds": [memory_id]},
            )
            item = (
                status_payload.get("items", [{}])[0]
                if isinstance(status_payload.get("items"), list)
                else {}
            )
            item = item if isinstance(item, dict) else {}
            state = item.get("state")
            status_history.append(
                {"httpStatus": status_code, "state": state, "stage": item.get("stage")}
            )
            final_processing = item
            if status_code != 200:
                raise LocalEvalError(f"processing status failed: HTTP {status_code}")
            if state in {"ready", "ready_text_only"}:
                break
            if state == "failed" or time.monotonic() >= deadline:
                raise LocalEvalError(f"processing did not reach ready: {state}")
            time.sleep(poll_seconds)
        steps["processing"] = {
            "statusHistory": status_history,
            "final": {
                "state": final_processing.get("state"),
                "stage": final_processing.get("stage"),
                "attemptCount": final_processing.get("attemptCount"),
            },
        }

        search_status, searched = _request(
            base_url,
            token,
            "POST",
            "/api/v1/memory/search",
            {
                **common,
                "requestId": f"{run_id}-search",
                "query": query,
                "limit": 20,
                "includeInjectedContext": False,
                "verbose": True,
            },
        )
        hit_ids = _hit_ids(searched)
        steps["search"] = {
            "httpStatus": search_status,
            "hitCount": len(_hits(searched)) if search_status == 200 else None,
            "memoryIdFound": memory_id in hit_ids,
            "markerPresent": run_id in json.dumps(searched, ensure_ascii=False),
        }
        if search_status != 200 or memory_id not in hit_ids:
            raise LocalEvalError("isolated synthetic memory was not recalled")
    finally:
        if memory_id:
            cleanup_attempted = True
            delete_status, deleted = _request(
                base_url,
                token,
                "DELETE",
                f"/api/v1/memory/{memory_id}",
                {"requestId": f"{run_id}-delete", "namespace": namespace},
            )
            steps["delete"] = {
                "httpStatus": delete_status,
                "ok": delete_status == 200 and deleted.get("status") == "deleted",
            }
            if not steps["delete"]["ok"]:
                cleanup_error = f"delete failed: HTTP {delete_status}"
            get_status, _ = _request(base_url, token, "GET", f"/api/v1/memory/{memory_id}")
            steps["getVerify"] = {"httpStatus": get_status, "absent": get_status == 404}
            search_status, after = _request(
                base_url,
                token,
                "POST",
                "/api/v1/memory/search",
                {
                    **common,
                    "requestId": f"{run_id}-search-after-delete",
                    "query": query,
                    "limit": 20,
                    "includeInjectedContext": False,
                    "verbose": True,
                },
            )
            steps["searchVerify"] = {
                "httpStatus": search_status,
                "markerPresent": run_id in json.dumps(after, ensure_ascii=False),
                "memoryIdFound": memory_id in _hit_ids(after),
            }

    passed = all(
        [
            steps.get("health", {}).get("ok") is True,
            steps.get("preSearch", {}).get("markerPresent") is False,
            steps.get("add", {}).get("httpStatus") == 200,
            steps.get("processing", {}).get("final", {}).get("state")
            in {"ready", "ready_text_only"},
            steps.get("search", {}).get("memoryIdFound") is True,
            steps.get("delete", {}).get("ok") is True,
            steps.get("getVerify", {}).get("absent") is True,
            steps.get("searchVerify", {}).get("markerPresent") is False,
            steps.get("searchVerify", {}).get("memoryIdFound") is False,
        ]
    )
    body = {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "run": {
            "id": run_id,
            "mode": "live-local-isolated",
            "result": "passed" if passed else "failed",
            "startedAt": started_at,
            "completedAt": _utc_now(),
            "durationMs": round((time.monotonic() - started_clock) * 1000, 3),
            "target": {"baseUrl": base_url, "loopbackOnly": True},
            "runner": {"id": "memos-local-isolated-eval", "version": "0.1.0"},
        },
        "service": service_health,
        "namespace": {
            "source": namespace["source"],
            "projectId": namespace["projectId"],
            "workspaceId": namespace["workspaceId"],
            "profileId": namespace["profileId"],
            "userId": namespace["userId"],
            "syntheticOnly": True,
        },
        "fixture": {
            "contentSha256": content_hash,
            "contentBytes": len(content.encode()),
            "query": query,
        },
        "steps": steps,
        "cleanup": {"attempted": cleanup_attempted, "error": cleanup_error},
        "notes": [
            "Only a synthetic memory in a unique namespace was written; no default namespace or cloud endpoint was used.",
            "Search responses may include read-only global Skill entries; pass/fail is based on the synthetic marker and memory id.",
            "ready proves local processing and recall availability; it is not a product quality score or release Gate.",
        ],
    }
    digest = _sha256(_canonical(body))
    body["reportSha256"] = digest
    return body


def write_report(report: dict[str, Any], output: str | Path) -> Path:
    destination = Path(output).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(_canonical(report) + b"\n")
    return destination


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a local-only disposable MemMate recall evaluation"
    )
    parser.add_argument("--base-url", default=DEFAULT_URL)
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)
    parser.add_argument("--run-id")
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = run_local_isolated_evaluation(
        base_url=args.base_url,
        token_env=args.token_env,
        timeout_seconds=args.timeout_seconds,
        poll_seconds=args.poll_seconds,
        run_id=args.run_id,
    )
    if args.output:
        write_report(report, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["run"]["result"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
