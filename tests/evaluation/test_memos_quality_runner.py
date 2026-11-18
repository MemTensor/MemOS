"""Tests for the deterministic Quality Pack shadow runner."""

from __future__ import annotations

import hashlib
import json
import threading

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any, ClassVar

import pytest


if TYPE_CHECKING:
    from pathlib import Path

from evaluation.quality_runner.memos_quality_runner import (
    MAX_EVIDENCE_REFS,
    MAX_TARGET_OUTPUT_BYTES,
    QualityPackError,
    _canonical_json,
    load_quality_dataset,
    run_fixture_validation,
    run_live_evaluation,
    write_report,
)


def _fixture(tmp_path: Path, *, sample_count: int = 2) -> Path:
    dataset_dir = tmp_path / "datasets" / "memos" / "memos-golden-recall-v0"
    dataset_dir.mkdir(parents=True)
    rows = []
    for index in range(sample_count):
        rows.append(
            {
                "id": f"memos-fixture-{index + 1}",
                "productId": "memos",
                "datasetId": "memos-golden-recall-v0",
                "query": f"What is remembered {index + 1}?",
                "memories": [
                    {"id": "m1", "content": "A redacted memory", "sourceRef": "fixture:D1:1"}
                ],
                "goldenAnswer": "A redacted memory",
                "acceptableAnswers": ["A redacted memory"],
                "evidenceRefs": ["D1:1"],
            }
        )
    encoded = "".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows
    ).encode("utf-8")
    samples_path = dataset_dir / "samples.jsonl"
    samples_path.write_bytes(encoded)
    manifest = {
        "schemaVersion": "1.0",
        "datasetId": "memos-golden-recall-v0",
        "productId": "memos",
        "displayName": "fixture",
        "version": "0.1.0",
        "status": "draft",
        "sampleCount": sample_count,
        "splitCounts": {"smoke": sample_count},
        "task": "memory_recall",
        "ownerConfirmation": {"status": "pending", "required": True, "scope": ["test"]},
        "source": {
            "kind": "synthetic",
            "dataset": "fixture",
            "repository": "fixture",
            "path": "fixture",
            "sourceCommit": "0" * 40,
            "sourceLicenseReview": "not_required",
            "transformations": ["fixture"],
        },
        "files": [
            {
                "path": "samples.jsonl",
                "format": "jsonl",
                "sha256": hashlib.sha256(encoded).hexdigest(),
                "lineCount": sample_count,
            }
        ],
        "contentHash": hashlib.sha256(encoded).hexdigest(),
        "execution": {
            "runnerInput": "memories + query",
            "expectedOutput": "answer + evidenceRefs",
            "scoring": "outside fixture runner",
            "networkRequired": False,
        },
    }
    (dataset_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return tmp_path


def test_loads_and_hashes_quality_pack(tmp_path: Path) -> None:
    root = _fixture(tmp_path)
    dataset = load_quality_dataset(root, "memos-golden-recall-v0")
    assert len(dataset.samples) == 2
    assert len(dataset.dataset_content_hash) == 64
    assert dataset.dataset_content_hash == dataset.files[0]["sha256"]
    assert dataset.sample_ids == ("memos-fixture-1", "memos-fixture-2")
    assert dataset.files[0]["lineCount"] == 2


def test_shadow_report_is_explicitly_not_available_and_has_no_model_metrics(tmp_path: Path) -> None:
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    report = run_fixture_validation(dataset, mode="shadow", run_id="eval-test")
    assert report["run"]["mode"] == "shadow"
    assert report["run"]["result"] == "not_available"
    assert report["scorecard"]["status"] == "not_available"
    assert report["scorecard"]["metrics"]["fixtureCoverage"] == 1.0
    assert report["scorecard"]["metrics"]["targetLatencyP95Ms"] is None
    assert report["scorecard"]["metrics"]["inputTokensTotal"] is None
    assert report["scorecard"]["metrics"]["costMicrosTotal"] is None
    assert all(item["status"] == "not_available" for item in report["items"])
    assert all(item["targetOutput"] is None for item in report["items"])
    body = {key: value for key, value in report.items() if key not in ("report", "reportSha256")}
    expected_hash = hashlib.sha256(_canonical_json(body)).hexdigest()
    assert report["reportSha256"] == expected_hash
    assert report["report"]["sha256"] == expected_hash


def test_write_report_is_parseable(tmp_path: Path) -> None:
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    destination = tmp_path / "out" / "run.json"
    report = run_fixture_validation(dataset, mode="mock")
    assert write_report(report, destination) == destination
    assert json.loads(destination.read_text(encoding="utf-8"))["run"]["mode"] == "mock"


def test_rejects_hash_mismatch_and_unsafe_path(tmp_path: Path) -> None:
    root = _fixture(tmp_path)
    manifest_path = next(root.rglob("manifest.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(QualityPackError, match="SHA-256"):
        load_quality_dataset(root, "memos-golden-recall-v0")


def test_rejects_missing_or_unbound_manifest_content_hash(tmp_path: Path) -> None:
    root = _fixture(tmp_path)
    manifest_path = next(root.rglob("manifest.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.pop("contentHash")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(QualityPackError, match="contentHash"):
        load_quality_dataset(root, "memos-golden-recall-v0")

    manifest["contentHash"] = "f" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(QualityPackError, match="contentHash"):
        load_quality_dataset(root, "memos-golden-recall-v0")


class _MockTargetHandler(BaseHTTPRequestHandler):
    calls: ClassVar[list[dict[str, Any]]] = []
    response_mode = "valid"

    def do_post(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length))
        self.__class__.calls.append(
            {
                "payload": payload,
                "authorization": self.headers.get("Authorization"),
            }
        )
        sample_id = payload["sampleId"]
        if self.response_mode == "mismatch":
            sample_id = "unexpected-sample"
        response = {
            "sampleId": sample_id,
            "traceId": f"{payload['runId']}:{payload['sampleId']}",
            "targetOutput": f"answer for {payload['query']}",
            "evidenceRefs": [f"target:{sample_id}:1"],
            "latencyMs": 12.5,
            "inputTokens": 7,
            "outputTokens": 9,
            "costMicros": 3,
        }
        if self.response_mode == "trace-mismatch":
            response["traceId"] = "unexpected-trace"
        if self.response_mode == "missing-observability":
            response.pop("latencyMs")
            response.pop("inputTokens")
            response.pop("outputTokens")
            response.pop("costMicros")
        if self.response_mode == "invalid-output":
            response["targetOutput"] = ""
        if self.response_mode == "oversized-output":
            response["targetOutput"] = "x" * (MAX_TARGET_OUTPUT_BYTES + 1)
        if self.response_mode == "too-many-evidence-refs":
            response["evidenceRefs"] = ["ref"] * (MAX_EVIDENCE_REFS + 1)
        encoded = json.dumps(response).encode("utf-8")
        self.send_response(200)
        content_type = (
            "text/plain" if self.response_mode == "bad-content-type" else "application/json"
        )
        self.send_header("Content-Type", content_type)
        content_length = (
            "invalid" if self.response_mode == "bad-content-length" else str(len(encoded))
        )
        self.send_header("Content-Length", content_length)
        self.end_headers()
        self.wfile.write(encoded)

    do_POST = do_post  # noqa: N815 - stdlib handler API

    def log_message(self, _format: str, *_args: Any) -> None:
        return


@pytest.fixture
def mock_target() -> Any:
    _MockTargetHandler.calls = []
    _MockTargetHandler.response_mode = "valid"
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MockTargetHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, _MockTargetHandler
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_live_runner_calls_explicit_target_and_keeps_observability_fields(
    tmp_path: Path, mock_target: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, handler = mock_target
    monkeypatch.setenv("MEMOS_TEST_EVAL_TOKEN", "local-only-token")
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    report = run_live_evaluation(
        dataset,
        target_url=f"http://127.0.0.1:{server.server_port}/evaluate",
        token_env="MEMOS_TEST_EVAL_TOKEN",
        timeout_seconds=2,
        run_id="eval-live-test",
    )

    assert report["run"]["mode"] == "live"
    assert report["run"]["result"] == "available"
    assert report["run"]["completedItemCount"] == 2
    assert report["scorecard"]["status"] == "not_scored"
    assert [item["targetOutput"] for item in report["items"]] == [
        "answer for What is remembered 1?",
        "answer for What is remembered 2?",
    ]
    assert all(item["evidenceRefs"] for item in report["items"])
    assert all(item["targetLatencyMs"] == 12.5 for item in report["items"])
    assert all(item["inputTokens"] == 7 for item in report["items"])
    assert all(item["outputTokens"] == 9 for item in report["items"])
    assert all(item["costMicros"] == 3 for item in report["items"])
    assert all(item["traceId"].endswith(item["id"]) for item in report["items"])
    assert len(handler.calls) == 2
    assert all(call["authorization"] == "Bearer local-only-token" for call in handler.calls)
    assert all("goldenAnswer" not in call["payload"] for call in handler.calls)
    serialized = json.dumps(report, ensure_ascii=False)
    assert "local-only-token" not in serialized
    assert report["qualityPack"]["contentHash"] == dataset.dataset_content_hash
    assert report["qualityPack"]["sampleIds"] == list(dataset.sample_ids)
    assert report["runner"]["manifest"]["networkRequired"] is True
    assert report["runner"]["manifest"]["outputContract"] == "badcase://evaluation-run/per-sample-v1"
    assert report["evidence"]["datasetId"] == dataset.dataset_id
    assert report["evidence"]["datasetContentHash"] == dataset.dataset_content_hash
    assert report["evidence"]["sampleIds"] == list(dataset.sample_ids)
    assert report["evidence"]["observedTraceCount"] == 2


def test_live_runner_fails_closed_on_sample_binding_error(
    tmp_path: Path, mock_target: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, handler = mock_target
    handler.response_mode = "mismatch"
    monkeypatch.setenv("MEMOS_TEST_EVAL_TOKEN", "local-only-token")
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    with pytest.raises(QualityPackError, match="sampleId"):
        run_live_evaluation(
            dataset,
            target_url=f"http://127.0.0.1:{server.server_port}/evaluate",
            token_env="MEMOS_TEST_EVAL_TOKEN",
            timeout_seconds=2,
        )


def test_live_runner_fails_closed_on_trace_binding_error(
    tmp_path: Path, mock_target: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, handler = mock_target
    handler.response_mode = "trace-mismatch"
    monkeypatch.setenv("MEMOS_TEST_EVAL_TOKEN", "local-only-token")
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    with pytest.raises(QualityPackError, match="traceId"):
        run_live_evaluation(
            dataset,
            target_url=f"http://127.0.0.1:{server.server_port}/evaluate",
            token_env="MEMOS_TEST_EVAL_TOKEN",
            timeout_seconds=2,
            run_id="eval-live-test",
        )


def test_live_runner_keeps_missing_observability_fields_null(
    tmp_path: Path, mock_target: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, handler = mock_target
    handler.response_mode = "missing-observability"
    monkeypatch.setenv("MEMOS_TEST_EVAL_TOKEN", "local-only-token")
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    report = run_live_evaluation(
        dataset,
        target_url=f"http://127.0.0.1:{server.server_port}/evaluate",
        token_env="MEMOS_TEST_EVAL_TOKEN",
        timeout_seconds=2,
    )
    assert all(item["targetLatencyMs"] is None for item in report["items"])
    assert all(item["inputTokens"] is None for item in report["items"])
    assert report["scorecard"]["metrics"]["targetLatencyP95Ms"] is None
    assert report["scorecard"]["metrics"]["inputTokensTotal"] is None


def test_live_runner_fails_closed_on_protocol_and_network_errors(
    tmp_path: Path, mock_target: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, handler = mock_target
    handler.response_mode = "bad-content-type"
    monkeypatch.setenv("MEMOS_TEST_EVAL_TOKEN", "local-only-token")
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    with pytest.raises(QualityPackError, match="Content-Type"):
        run_live_evaluation(
            dataset,
            target_url=f"http://127.0.0.1:{server.server_port}/evaluate",
            token_env="MEMOS_TEST_EVAL_TOKEN",
            timeout_seconds=2,
        )
    handler.response_mode = "bad-content-length"
    with pytest.raises(QualityPackError, match="Content-Length"):
        run_live_evaluation(
            dataset,
            target_url=f"http://127.0.0.1:{server.server_port}/evaluate",
            token_env="MEMOS_TEST_EVAL_TOKEN",
            timeout_seconds=2,
        )
    handler.response_mode = "bad-content-type"
    with pytest.raises(QualityPackError, match="网络请求"):
        run_live_evaluation(
            dataset,
            target_url="http://127.0.0.1:1/evaluate",
            token_env="MEMOS_TEST_EVAL_TOKEN",
            timeout_seconds=0.2,
        )


def test_live_runner_bounds_target_output_and_evidence_refs(
    tmp_path: Path, mock_target: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, handler = mock_target
    monkeypatch.setenv("MEMOS_TEST_EVAL_TOKEN", "local-only-token")
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    for mode, message in (
        ("invalid-output", "targetOutput"),
        ("oversized-output", "targetOutput"),
        ("too-many-evidence-refs", "evidenceRefs"),
    ):
        handler.response_mode = mode
        with pytest.raises(QualityPackError, match=message):
            run_live_evaluation(
                dataset,
                target_url=f"http://127.0.0.1:{server.server_port}/evaluate",
                token_env="MEMOS_TEST_EVAL_TOKEN",
                timeout_seconds=2,
            )


def test_live_runner_requires_explicit_target_and_token_env(tmp_path: Path) -> None:
    dataset = load_quality_dataset(_fixture(tmp_path), "memos-golden-recall-v0")
    with pytest.raises(QualityPackError, match="target URL"):
        run_live_evaluation(dataset, target_url="")
    with pytest.raises(QualityPackError, match="环境变量"):
        run_live_evaluation(dataset, target_url="http://127.0.0.1:1/evaluate", token_env="MISSING")
