from datetime import datetime, timedelta, timezone

import pytest

from memos.project_dbs.ranking import RankSignals, rank_bonus, rank_time


T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)


def test_no_signals_means_no_bonus():
    signals = RankSignals()
    bonus = rank_bonus(signals)
    assert bonus["total"] == 0
    assert rank_time(T0, signals) == (T0, bonus)


def test_each_signal_contributes_its_weight():
    bonus = rank_bonus(
        RankSignals(
            open_conflicts=1,
            active_decisions=2,
            verified_experiences=1,
            members=3,
            conversations=2,
        )
    )
    assert bonus == {
        "open_conflicts": 12,
        "active_decisions": 8,
        "verified_experiences": 6,
        "members": 12,
        "conversations": 3,
        "total": 41,
    }


def test_single_member_and_conversation_earn_nothing():
    bonus = rank_bonus(RankSignals(members=1, conversations=1))
    assert (bonus["members"], bonus["conversations"], bonus["total"]) == (0, 0, 0)


def test_active_decisions_are_capped_at_six():
    assert rank_bonus(RankSignals(active_decisions=6))["active_decisions"] == 24
    assert rank_bonus(RankSignals(active_decisions=40))["active_decisions"] == 24


def test_total_is_capped_at_72_hours():
    signals = RankSignals(open_conflicts=10, members=5)
    bonus = rank_bonus(signals)
    assert bonus["open_conflicts"] == 120 and bonus["total"] == 72
    assert rank_time(T0, signals)[0] == T0 + timedelta(hours=72)


def test_rank_time_adds_bonus_to_update_time():
    when, bonus = rank_time(T0, RankSignals(open_conflicts=1, conversations=3))
    assert bonus["total"] == 18
    assert when == T0 + timedelta(hours=18)


@pytest.mark.parametrize("field", list(RankSignals.__dataclass_fields__))
def test_negative_counts_are_rejected(field):
    with pytest.raises(ValueError):
        RankSignals(**{field: -1})
