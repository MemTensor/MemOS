"""Episode boundary judgment: did the member switch to another piece of work?

Acceptance closes an Episode on budgets only (idle, waiting time, turn count, volume). Before
extraction, the judge answers yes/no questions about the closed Episode, in the choice-question
protocol a Jev backend serves (``ModelHub.judge``):

- ``t<i>`` for each turn after the first: does turn i start another work than turn i-1?
  The Episode is split before every turn answered yes.
- ``continues`` when the conversation has a previous Episode: does turn 0 continue its work?
  Only a continuation keeps the previous Topic as a must-consider candidate, so a switch in
  the same conversation is not attached to the old work just because the conversation is the
  same.

A switch is a move to another independently deliverable work; follow-ups, corrections, added
requirements, acceptance and release checks of the same work continue it. ``unsure`` never
splits and counts as continuing, so doubt keeps the conservative default. The answers are a
few tokens, without free-text reasons, so a cheaper judge model or a Jev backend can serve them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .add_extraction import _shorten
from .judge import NO, YES, ModelError


if TYPE_CHECKING:
    from .judge import ModelHub


# Stated once in the material; each question only names the turns it asks about.
_RULE = (
    "工作指一个功能、接口、配置项、规则、文档或分析产出。同一工作的追问、修正、补充要求、验收、"
    "测试和发布前检查都不算转换；寒暄、致谢和结束语不算新工作。只有转到可以独立交付、结论互不影响"
    "的另一项工作才算转换。"
)
_SWITCH = "按 `rule`，成员在第 {i} 轮是否转到了与第 {j} 轮不同的工作？"
_CONTINUES = "按 `rule`，第 0 轮是否接着 `previous` 的那项工作？"

_MEMBER_CHARS = 1200
_AGENT_CHARS = 400


@dataclass(frozen=True)
class Boundary:
    """Where the member's tasks start (turn indexes, always beginning at 0)."""

    starts: tuple[int, ...]
    continues_previous: bool
    reasons: tuple[str, ...] = ()
    judged: bool = True

    @property
    def split(self) -> bool:
        return len(self.starts) > 1


def needs_judgment(turns: list[dict], previous: dict | None) -> bool:
    """A model call only when there is something to decide."""
    return len(turns) > 1 or bool(previous)


def boundary_input(turns: list[dict], previous: dict | None) -> dict[str, Any]:
    """Judge material: each turn's member words and a bounded slice of the Agent reply."""
    return {
        "rule": _RULE,
        "previous": (
            {
                "summary": str(previous.get("episode_summary") or ""),
                "topic_name": previous.get("topic_name") or "",
            }
            if previous
            else None
        ),
        "turns": [
            {
                "turn": index,
                "member": _shorten(str(turn.get("member") or ""), _MEMBER_CHARS),
                "agent": _shorten(str(turn.get("agent") or ""), _AGENT_CHARS),
            }
            for index, turn in enumerate(turns)
        ],
    }


def boundary_questions(turns: list[dict], previous: dict | None) -> dict[str, dict[str, str]]:
    """One yes/no question per turn after the first, plus the continuation question."""
    questions = {
        f"t{i}": {"type": "noul", "instructions": _SWITCH.format(i=i, j=i - 1)}
        for i in range(1, len(turns))
    }
    if previous:
        questions["continues"] = {"type": "noul", "instructions": _CONTINUES}
    return questions


def parse_answers(answers: Any, turns: list[dict], previous: dict | None) -> Boundary:
    """Split before every turn answered yes; only an explicit no ends the continuation."""
    if not isinstance(answers, dict):
        raise ModelError("Invalid Episode boundary judgment")
    expected = boundary_questions(turns, previous)
    if missing := sorted(set(expected) - set(answers)):
        raise ModelError(f"Episode boundary judgment misses {missing}")
    starts = [0] + [
        i for i in range(1, len(turns)) if getattr(answers[f"t{i}"], "value", None) == YES
    ]
    continues = bool(previous) and getattr(answers.get("continues"), "value", None) != NO
    return Boundary(starts=tuple(starts), continues_previous=continues)


def judge_boundary(hub: ModelHub, turns: list[dict], previous: dict | None) -> Boundary:
    """Ask the judge where tasks start; a trivial Episode needs no call.

    `turns` items carry the member's words (`member`) and the Agent's reply (`agent`);
    `previous` is the conversation's previous Episode (`episode_summary`, `topic_name`).
    """
    if not turns or not needs_judgment(turns, previous):
        return Boundary(starts=(0,), continues_previous=False, judged=False)
    questions = boundary_questions(turns, previous)
    answers = hub.judge("episode.boundary", boundary_input(turns, previous), questions)
    return parse_answers(answers, turns, previous)


def unjudged(previous: dict | None) -> Boundary:
    """The fallback after the judge stays unavailable: one segment, continuity assumed.

    An unknown continuation keeps the previous Topic as a candidate, so an outage degrades to
    the rule-free default instead of failing the Episode.
    """
    return Boundary(starts=(0,), continues_previous=bool(previous), judged=False)
