"""Captured values must be detached, bounded, and sanitized."""

import json

from copy import deepcopy

from memos_smartcomment.serialization import to_jsonable


def test_snapshot_redacts_nested_values_without_mutating_input() -> None:
    payload = {
        "nested": [{"api_key": "synthetic-key", "embedding": [0.1, 0.2]}],
        "arguments": json.dumps({"password": "synthetic-password", "query": "hello"}),
        "argument": "not valid JSON",
        "text": "x" * 81,
    }
    original = deepcopy(payload)

    snapshot = to_jsonable(payload, max_value_chars=80)

    assert payload == original
    payload["nested"][0]["api_key"] = "changed"
    payload["nested"].append({"extra": "later mutation"})
    assert snapshot["nested"] == [{"api_key": "<redacted>", "embedding": "<omitted-vector:2>"}]
    assert json.loads(snapshot["arguments"]) == {"password": "<redacted>", "query": "hello"}
    assert snapshot["argument"] == "<omitted-unparseable-arguments>"
    assert snapshot["text"] == "x" * 80 + "…"
