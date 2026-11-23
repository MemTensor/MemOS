"""Provider-reported usage metering for chat and embedding adapters."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.configs.llm import LLMConfigFactory
from memos.embedders.universal_api import UniversalAPIEmbedder
from memos.llms.factory import LLMFactory
from memos.llms.usage import (
    CHAT,
    EMBEDDING,
    expect_usage,
    merge_usage,
    meter_usage,
    record_usage,
    usage_counts,
)


def _llm(**config):
    return LLMFactory.from_config(
        LLMConfigFactory.model_validate(
            {
                "backend": "openai",
                "config": {"model_name_or_path": "chat-a", "api_key": "sk", **config},
            }
        )
    )


def _completion(usage):
    message = SimpleNamespace(content='{"ok": true}', reasoning_content=None, tool_calls=None)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message)],
        usage=usage,
        model_dump_json=lambda: "{}",
    )


def test_usage_counts_reads_openai_and_deepseek_shapes():
    openai_usage = SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=20,
        total_tokens=120,
        prompt_tokens_details=SimpleNamespace(cached_tokens=64),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=5),
    )
    assert usage_counts(openai_usage) == {
        "prompt_tokens": 100,
        "completion_tokens": 20,
        "total_tokens": 120,
        "cached_tokens": 64,
        "reasoning_tokens": 5,
    }
    deepseek = {"prompt_tokens": 10, "completion_tokens": 3, "prompt_cache_hit_tokens": 8}
    assert usage_counts(deepseek)["cached_tokens"] == 8
    assert usage_counts(deepseek)["total_tokens"] == 13
    assert usage_counts(MagicMock()) == dict.fromkeys(usage_counts(None), 0)


def test_record_usage_is_dropped_without_an_active_meter():
    record_usage(CHAT, "chat-a", {"prompt_tokens": 1})
    with meter_usage() as meter:
        record_usage(CHAT, "chat-a", {"prompt_tokens": 2, "completion_tokens": 1})
        record_usage(CHAT, "chat-a", None)
        record_usage(EMBEDDING, "embed-a", {"prompt_tokens": 7, "total_tokens": 7})
    record_usage(CHAT, "chat-a", {"prompt_tokens": 1})
    rows = {(row["kind"], row["model"]): row for row in meter.summary()}
    assert rows[(CHAT, "chat-a")]["calls"] == 2
    assert rows[(CHAT, "chat-a")]["calls_without_usage"] == 1
    assert rows[(CHAT, "chat-a")]["total_tokens"] == 3
    assert rows[(EMBEDDING, "embed-a")]["prompt_tokens"] == 7


def test_expect_usage_fills_in_for_adapters_that_do_not_report():
    with meter_usage() as meter:
        with expect_usage(CHAT, "local"):
            pass
        with expect_usage(CHAT, "chat-a"):
            record_usage(CHAT, "chat-a", {"prompt_tokens": 4})
        with pytest.raises(RuntimeError), expect_usage(CHAT, "local"):
            raise RuntimeError("down")
    rows = {row["model"]: row for row in meter.summary()}
    assert rows["local"] == {**rows["local"], "calls": 2, "calls_without_usage": 1}
    assert rows["local"]["failed_calls"] == 1
    assert rows["chat-a"]["calls"] == 1


def test_merge_usage_sums_by_kind_and_model():
    rows = merge_usage(
        [{"kind": CHAT, "model": "a", "calls": 1, "prompt_tokens": 3}],
        [{"kind": CHAT, "model": "a", "calls": 2, "prompt_tokens": 4}],
    )
    assert rows[0]["calls"] == 3 and rows[0]["prompt_tokens"] == 7


def test_openai_chat_records_primary_failure_and_backup_usage():
    llm = _llm(
        backup_client=True,
        backup_api_key="sk",
        backup_api_base="https://backup.example/v1",
        backup_model_name_or_path="chat-b",
    )
    llm.client.chat.completions.create = MagicMock(side_effect=ConnectionError("down"))
    llm.backup_client.chat.completions.create = MagicMock(
        return_value=_completion({"prompt_tokens": 30, "completion_tokens": 6})
    )
    with meter_usage() as meter:
        assert llm.generate([{"role": "user", "content": "hi"}]) == '{"ok": true}'
    rows = {row["model"]: row for row in meter.summary()}
    assert rows["chat-a"]["failed_calls"] == 1
    assert rows["chat-b"]["total_tokens"] == 36


def test_openai_chat_counts_responses_without_usage():
    llm = _llm()
    llm.client.chat.completions.create = MagicMock(return_value=_completion(None))
    with meter_usage() as meter, expect_usage(CHAT, "chat-a"):
        llm.generate([{"role": "user", "content": "hi"}])
    assert meter.summary()[0]["calls"] == 1
    assert meter.summary()[0]["calls_without_usage"] == 1


def test_universal_embedder_records_provider_usage():
    embedder = UniversalAPIEmbedder(
        UniversalAPIEmbedderConfig(provider="openai", api_key="k", model_name_or_path="embed-a")
    )
    response = SimpleNamespace(
        data=[SimpleNamespace(embedding=[0.1, 0.2])],
        usage=SimpleNamespace(prompt_tokens=9, total_tokens=9),
    )
    embedder.client.embeddings.create = MagicMock(return_value=response)
    with meter_usage() as meter:
        assert embedder.embed(["text"]) == [[0.1, 0.2]]
    assert meter.summary() == [
        {
            "kind": EMBEDDING,
            "model": "embed-a",
            "calls": 1,
            "failed_calls": 0,
            "calls_without_usage": 0,
            "prompt_tokens": 9,
            "completion_tokens": 0,
            "total_tokens": 9,
            "cached_tokens": 0,
            "reasoning_tokens": 0,
        }
    ]
