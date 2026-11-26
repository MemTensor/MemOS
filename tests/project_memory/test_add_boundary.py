import pytest

from memos.project_memory.add_boundary import (
    boundary_questions,
    judge_boundary,
    parse_answers,
    unjudged,
)
from memos.project_memory.judge import Answer, ModelError


class Judge:
    def __init__(self, values):
        self.values = values
        self.calls = []

    def judge(self, scope, state, questions):
        self.calls.append((scope, state, questions))
        if isinstance(self.values, Exception):
            raise self.values
        return {q: Answer(q, self.values.get(q, "unsure")) for q in questions}


TURNS = [
    {"member": "帮我把导出接口的失败重试改成 3 次", "agent": "已改为 3 次"},
    {"member": "重试间隔也加上指数退避", "agent": "已加上"},
    {"member": "另外看下税务规则里的起征点怎么算", "agent": "起征点为 5000"},
]
PREVIOUS = {"episode_summary": "导出接口重试", "topic_name": "导出重试"}


def test_a_single_turn_without_history_needs_no_call():
    judge = Judge({})
    boundary = judge_boundary(judge, TURNS[:1], None)
    assert judge.calls == [] and boundary.starts == (0,) and not boundary.judged


def test_questions_are_one_yes_no_per_turn_plus_continuation():
    questions = boundary_questions(TURNS, PREVIOUS)
    assert list(questions) == ["t1", "t2", "continues"]
    assert all(spec["type"] == "noul" for spec in questions.values())
    assert "`rule`" in questions["t1"]["instructions"]
    assert "continues" not in boundary_questions(TURNS, None)


def test_the_episode_splits_before_each_turn_answered_yes():
    judge = Judge({"t1": "no", "t2": "yes", "continues": "yes"})
    boundary = judge_boundary(judge, TURNS, PREVIOUS)
    scope, state, _ = judge.calls[0]
    assert scope == "episode.boundary" and state["previous"]["topic_name"] == "导出重试"
    assert boundary.starts == (0, 2) and boundary.split and boundary.continues_previous


@pytest.mark.parametrize(
    ("continues", "expected"), [("yes", True), ("unsure", True), ("no", False)]
)
def test_unsure_never_splits_and_counts_as_continuing(continues, expected):
    judge = Judge({"t1": "unsure", "t2": "unsure", "continues": continues})
    boundary = judge_boundary(judge, TURNS, PREVIOUS)
    assert boundary.starts == (0,) and boundary.continues_previous is expected


def test_continuation_needs_a_previous_episode():
    answers = {"t1": Answer("t1", "no"), "t2": Answer("t2", "no")}
    assert not parse_answers(answers, TURNS, None).continues_previous


def test_missing_answers_raise_for_the_stage_to_retry():
    with pytest.raises(ModelError):
        parse_answers({"t1": Answer("t1", "yes")}, TURNS, PREVIOUS)
    with pytest.raises(ModelError):
        parse_answers(None, TURNS, PREVIOUS)


def test_judge_outage_falls_back_to_one_segment_that_keeps_the_previous_topic():
    assert unjudged(PREVIOUS).starts == (0,) and unjudged(PREVIOUS).continues_previous
    assert not unjudged(None).continues_previous
