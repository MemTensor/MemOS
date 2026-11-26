"""Importance key for get/memory: a topic ranks as if it were updated a little later.

rank_time = update_time + bonus, where the bonus (hours, capped at RANK_CAP_HOURS) rewards
topics that need attention or matter to more people:

    12h x open conflicts (CONFLICT child rows)
  +  4h x min(active decisions, 6)
  +  6h x verified experiences (ACTIVE experiences with extra.exp_status = 'verified')
  +  6h x max(0, distinct members - 1)
  +  3h x max(0, distinct conversations - 1)

Members are the union of user_ids over ACTIVE entries plus sources[].user_id; conversations
are topics.conversation_ids. Storage recomputes the key after every write that touches a
topic and stores it in topics.extra.rank_time, with the breakdown in topics.extra.rank.
"""

from dataclasses import dataclass, fields
from datetime import datetime, timedelta


RANK_CAP_HOURS = 72
OPEN_CONFLICT_HOURS = 12
ACTIVE_DECISION_HOURS = 4
ACTIVE_DECISION_CAP = 6
VERIFIED_EXPERIENCE_HOURS = 6
MEMBER_HOURS = 6
CONVERSATION_HOURS = 3


@dataclass(frozen=True)
class RankSignals:
    open_conflicts: int = 0
    active_decisions: int = 0
    verified_experiences: int = 0
    members: int = 0
    conversations: int = 0

    def __post_init__(self) -> None:
        for field in fields(self):
            if getattr(self, field.name) < 0:
                raise ValueError(f"{field.name} must not be negative")


def rank_bonus(signals: RankSignals) -> dict[str, int]:
    """Hours earned per signal plus the capped "total"."""
    bonus = {
        "open_conflicts": OPEN_CONFLICT_HOURS * signals.open_conflicts,
        "active_decisions": ACTIVE_DECISION_HOURS
        * min(signals.active_decisions, ACTIVE_DECISION_CAP),
        "verified_experiences": VERIFIED_EXPERIENCE_HOURS * signals.verified_experiences,
        "members": MEMBER_HOURS * max(0, signals.members - 1),
        "conversations": CONVERSATION_HOURS * max(0, signals.conversations - 1),
    }
    bonus["total"] = min(RANK_CAP_HOURS, sum(bonus.values()))
    return bonus


def rank_time(update_time: datetime, signals: RankSignals) -> tuple[datetime, dict[str, int]]:
    """The ranking key and its breakdown."""
    bonus = rank_bonus(signals)
    return update_time + timedelta(hours=bonus["total"]), bonus
