from unittest.mock import patch

from memos.mem_scheduler.analyzer.eval_analyzer import EvalAnalyzer


def test_eval_analyzer_uses_unified_openai_endpoint_env(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "unified-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://unified.example/v1")
    legacy_prefix = "MEMSCHEDULER_OPENAI_"
    monkeypatch.setenv(legacy_prefix + "API_KEY", "legacy-key")
    monkeypatch.setenv(legacy_prefix + "BASE_URL", "https://legacy.example/v1")
    monkeypatch.delenv("MEMSCHEDULER_OPENAI_DEFAULT_MODEL", raising=False)

    with patch("memos.mem_scheduler.analyzer.eval_analyzer.OpenAI") as openai:
        analyzer = EvalAnalyzer(output_dir=str(tmp_path))

    openai.assert_called_once_with(
        api_key="unified-key",
        base_url="https://unified.example/v1",
    )
    assert analyzer.openai_model == "gpt-4o-mini"


def test_eval_analyzer_keeps_scheduler_default_model_override(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "unified-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://unified.example/v1")
    monkeypatch.setenv("MEMSCHEDULER_OPENAI_DEFAULT_MODEL", "gpt-4.1-mini")

    with patch("memos.mem_scheduler.analyzer.eval_analyzer.OpenAI"):
        analyzer = EvalAnalyzer(output_dir=str(tmp_path))

    assert analyzer.openai_model == "gpt-4.1-mini"
