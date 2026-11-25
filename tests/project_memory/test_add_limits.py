import pytest

from memos.project_memory.add_limits import LengthSettings, count_units, cut_at_sentence


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


def test_description_room_grows_with_the_topic_up_to_the_cap():
    limits = LengthSettings()
    assert limits.description(0) == 600
    assert limits.description(10) == 1200
    assert limits.description(100) == 2000


def test_limits_come_from_server_settings(monkeypatch):
    monkeypatch.setenv("PROJECT_MEMORY_DESCRIPTION_BASE", "800")
    monkeypatch.setenv("PROJECT_MEMORY_DECISION_LIMIT", "120")
    limits = LengthSettings.from_env()
    assert limits.description(0) == 800 and limits.entry("decision") == 120
    assert limits.entry("experience") == 200


def test_invalid_limits_are_rejected():
    with pytest.raises(ValueError):
        LengthSettings(description_base=900, description_cap=800)
