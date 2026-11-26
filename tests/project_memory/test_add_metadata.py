from memos.project_memory.add_limits import LengthSettings, count_units
from memos.project_memory.add_merge import _revision_text, rewrite_metadata
from memos.project_memory.judge import ModelError


class Writer:
    """Answers each metadata call from a queue and keeps the inputs it was given."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.inputs = []
        self.prompts = []

    def write(self, scope, prompt, inputs=None):
        assert scope == "episode.metadata"
        self.prompts.append(prompt)
        self.inputs.append(inputs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def _changeset(decisions=3):
    topic = {
        "id": "topic-1",
        "topic_name": "导出重试",
        "decisions": [
            {"content": f"导出失败重试 {n} 次", "time": f"2026-11-0{n + 1}T00:00:00Z"}
            for n in range(decisions)
        ],
        "experiences": [],
        "timeline": [{"content": "已上线导出重试", "time": "2026-11-09T00:00:00Z"}],
    }
    return {"topics": [{"topic": topic}], "warnings": []}


LIMITS = LengthSettings(
    topic_summary=10, description_base=20, description_per_entry=5, description_cap=40
)


def test_prompt_states_the_budget_that_grows_with_the_topic():
    writer = Writer({"summary": "导出重试", "description": "导出失败重试 2 次。"})
    out = rewrite_metadata(writer, _changeset(decisions=3), LIMITS)
    assert "不超过 10 字" in writer.prompts[0] and "不超过 35 字" in writer.prompts[0]
    assert out["topics"][0]["topic"]["topic_description"] == "导出失败重试 2 次。"
    assert out["warnings"] == []


def test_an_overlong_answer_is_sent_back_to_be_compressed():
    long = "导出失败重试 2 次。" * 8
    writer = Writer(
        {"summary": "导出重试", "description": long},
        {"summary": "导出重试", "description": "导出失败重试 2 次。"},
    )
    out = rewrite_metadata(writer, _changeset(), LIMITS)
    assert writer.inputs[1]["previous_output"]["description"] == long
    assert writer.inputs[1]["previous_length"]["description"] == count_units(long)
    assert out["topics"][0]["topic"]["topic_description"] == "导出失败重试 2 次。"
    assert out["warnings"] == []


def test_a_still_overlong_answer_is_cut_at_a_sentence_with_a_warning():
    long = {"summary": "导出重试", "description": "导出失败重试 2 次。" * 8}
    out = rewrite_metadata(Writer(long, ModelError("down")), _changeset(), LIMITS)
    description = out["topics"][0]["topic"]["topic_description"]
    assert description.endswith("。") and count_units(description) <= 35
    assert out["warnings"] == ["METADATA_TRUNCATED:topic-1"]


def test_nothing_usable_falls_back_to_the_facts_with_a_warning():
    invented = {"summary": "导出重试", "description": "重试 99 次"}
    out = rewrite_metadata(Writer(invented, invented), _changeset(), LIMITS)
    topic = out["topics"][0]["topic"]
    assert "99" not in topic["topic_description"] and topic["topic_summary"]
    assert out["warnings"] == ["METADATA_FALLBACK:topic-1"]


def test_future_wording_is_left_to_the_model_not_a_keyword_rule():
    writer = Writer({"summary": "导出重试", "description": "下一步上线导出重试。"})
    out = rewrite_metadata(writer, _changeset(), LIMITS)
    assert out["topics"][0]["topic"]["topic_description"] == "下一步上线导出重试。"


def test_revision_record_fits_the_timeline_limit_and_keeps_both_sides():
    old, new = "旧" * 80, "新" * 80
    text = _revision_text("张三", old, new, limit=40)
    assert count_units(text) <= 40
    assert text.startswith("张三 将结论从「旧") and "改为「新" in text
    assert _revision_text("张三", "8", "16") == "张三 将结论从「8」改为「16」"
