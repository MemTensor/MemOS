from unittest.mock import patch

from memos.mem_scheduler.analyzer.eval_analyzer import EvalAnalyzer


def test_eval_analyzer_uses_unified_openai_endpoint_env(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "unified-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://unified.example/v1")
    monkeypatch.setenv("MEMSCHEDULER_MODEL", "gpt-4o-mini")
    legacy_prefix = "MEMSCHEDULER_OPENAI_"
    monkeypatch.setenv(legacy_prefix + "API_KEY", "legacy-key")
    monkeypatch.setenv(legacy_prefix + "BASE_URL", "https://legacy.example/v1")

    with patch("memos.mem_scheduler.analyzer.eval_analyzer.OpenAI") as openai:
        analyzer = EvalAnalyzer(output_dir=str(tmp_path))

    openai.assert_called_once_with(
        api_key="unified-key",
        base_url="https://unified.example/v1",
    )
    assert analyzer.openai_model == "gpt-4o-mini"


def test_eval_analyzer_falls_back_to_general_model(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMSCHEDULER_MODEL", raising=False)
    monkeypatch.setenv("MEMREADER_GENERAL_MODEL", "qwen3.6-flash")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_API_BASE", "https://dashscope.example/v1")

    with patch("memos.mem_scheduler.analyzer.eval_analyzer.OpenAI") as openai:
        analyzer = EvalAnalyzer(output_dir=str(tmp_path))

    openai.assert_called_once_with(
        api_key="qwen-key",
        base_url="https://dashscope.example/v1",
    )
    assert analyzer.openai_model == "qwen3.6-flash"
