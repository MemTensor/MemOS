import json

import pytest

from memos.project_memory.add_limits import (
    LengthSettings,
    count_units,
    cut_at_sentence,
    load_limits,
)


def test_units_count_cjk_characters_and_latin_words_alike():
    assert count_units("导出接口支持重试") == 8
    assert count_units("Export retries use api/v1/export twice.") == 5
    assert count_units("超时 30 秒，使用 retry_policy.max_attempts") == 7
    assert count_units("，。！ ...") == 0


def test_short_text_is_kept_whole():
    assert cut_at_sentence("  保持原样。  ", 10) == ("保持原样。", False)


def test_cut_ends_at_the_last_sentence_that_fits():
    text = "第一句说明做法。第二句说明进展。第三句很长很长很长很长"
    cut, truncated = cut_at_sentence(text, 16)
    assert truncated and cut == "第一句说明做法。第二句说明进展。"


def test_english_cut_keeps_whole_sentences():
    text = "Retries are capped at three. The export writes to S3. Logs rotate daily."
    cut, truncated = cut_at_sentence(text, 11)
    assert truncated and cut == "Retries are capped at three. The export writes to S3."


def test_cut_without_a_sentence_end_marks_the_ellipsis():
    cut, truncated = cut_at_sentence("没有任何句号的一段很长的文字内容", 6)
    assert truncated and cut == "没有任何句…" and count_units(cut) == 5


def test_defaults_come_from_the_packaged_yaml_and_exceed_the_prd_sizes():
    limits = load_limits({})
    assert limits == LengthSettings()
    assert (limits.topic_name, limits.topic_summary) == (30, 160)
    assert (limits.decision, limits.timeline, limits.experience) == (200, 200, 400)
    assert limits.description(0) == 800
    assert limits.description(10) == 1600
    assert limits.description(100) == 3000


@pytest.mark.parametrize("suffix", [".yaml", ".json"])
def test_a_deployment_file_then_environment_variables_override(tmp_path, suffix):
    path = tmp_path / f"limits{suffix}"
    data = {"topic_summary": 240, "decision": 300}
    path.write_text(
        json.dumps(data) if suffix == ".json" else "topic_summary: 240\ndecision: 300\n"
    )
    limits = load_limits(
        {"PROJECT_MEMORY_LIMITS_FILE": str(path), "PROJECT_MEMORY_LIMIT_DECISION": "120"}
    )
    assert limits.topic_summary == 240 and limits.decision == 120
    assert limits.entry("experience") == 400


@pytest.mark.parametrize(
    ("content", "environ"),
    [
        ("topic_sumary: 100\n", {}),
        ("decision: -1\n", {}),
        ("description_base: 900\ndescription_cap: 800\n", {}),
        ("", {"PROJECT_MEMORY_LIMIT_DECISION": "many"}),
    ],
    ids=["unknown-key", "negative", "cap-below-base", "non-integer-env"],
)
def test_invalid_limits_are_rejected_at_startup(tmp_path, content, environ):
    path = tmp_path / "limits.yaml"
    path.write_text(content)
    with pytest.raises(ValueError):
        load_limits({"PROJECT_MEMORY_LIMITS_FILE": str(path), **environ})


def test_text_without_spaces_is_also_bounded_in_characters():
    cut, truncated = cut_at_sentence("a" * 500, 10)
    assert truncated and len(cut) == 120 and cut.endswith("…")
