import pytest

from memos.project_memory.add_boundary import (
    _BOUNDARY,
    judge_boundary,
    parse_boundary,
    unjudged,
)
from memos.project_memory.judge import ModelError


class Writer:
    def __init__(self, output):
        self.output = output
        self.calls = []

    def write(self, scope, prompt, inputs):
        self.calls.append((scope, inputs))
        if isinstance(self.output, Exception):
            raise self.output
        return self.output


TURNS = [
    {"member": "帮我把导出接口的失败重试改成 3 次", "agent": "已改为 3 次"},
    {"member": "重试间隔也加上指数退避", "agent": "已加上"},
    {"member": "另外看下税务规则里的起征点怎么算", "agent": "起征点为 5000"},
]
PREVIOUS = {"episode_summary": "导出接口重试", "topic_name": "导出重试"}


def test_a_single_turn_without_history_needs_no_model_call():
    writer = Writer({})
    boundary = judge_boundary(writer, TURNS[:1], None)
    assert writer.calls == [] and boundary.starts == (0,) and not boundary.judged


def test_the_model_splits_where_the_member_starts_another_work():
    writer = Writer(
        {
            "continues_previous": True,
            "segments": [
                {"start_turn": 0, "reason": "", "quote": ""},
                {"start_turn": 2, "reason": "转到税务规则", "quote": "看下税务规则里的起征点"},
            ],
        }
    )
    boundary = judge_boundary(writer, TURNS, PREVIOUS)
    assert writer.calls[0][0] == "episode.boundary"
    assert writer.calls[0][1]["previous"]["topic_name"] == "导出重试"
    assert boundary.starts == (0, 2) and boundary.split and boundary.continues_previous


@pytest.mark.parametrize(
    "segment",
    [
        {"start_turn": 2, "quote": "改一下导入接口"},
        {"start_turn": 5, "quote": "看下税务规则"},
        {"start_turn": 2, "quote": ""},
        {"start_turn": True, "quote": "看下税务规则"},
    ],
    ids=["quote-not-in-turn", "out-of-range", "no-quote", "bool-index"],
)
def test_a_split_without_the_member_s_own_words_is_ignored(segment):
    boundary = parse_boundary({"continues_previous": False, "segments": [segment]}, TURNS, None)
    assert boundary.starts == (0,)


def test_continuation_needs_a_previous_episode():
    output = {"continues_previous": True, "segments": []}
    assert not parse_boundary(output, TURNS, None).continues_previous
    assert parse_boundary(output, TURNS, PREVIOUS).continues_previous


@pytest.mark.parametrize(
    "output",
    [None, {"segments": []}, {"continues_previous": "yes", "segments": []}],
    ids=["none", "missing", "text"],
)
def test_malformed_judgments_raise_for_the_stage_to_retry(output):
    with pytest.raises(ModelError):
        parse_boundary(output, TURNS, PREVIOUS)


def test_model_outage_falls_back_to_one_segment_that_keeps_the_previous_topic():
    assert unjudged(PREVIOUS).starts == (0,) and unjudged(PREVIOUS).continues_previous
    assert not unjudged(None).continues_previous


def test_prompt_treats_follow_ups_as_the_same_work_and_quotes_switches():
    assert "追问、修正、补充要求、验收" in _BOUNDARY
    assert "拿不准时视为延续" in _BOUNDARY
    assert "quote 逐字引用" in _BOUNDARY
