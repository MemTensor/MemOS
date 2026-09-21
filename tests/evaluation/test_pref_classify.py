import importlib.util
import itertools

from pathlib import Path

import pytest


MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "evaluation" / "scripts" / "utils" / "pref_classify.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("pref_classify", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pref_classify = _load_module()


def _judge(violate, acknowledge, hallucinate, helpful):
    return {
        "violate_preference": {"answer": violate},
        "acknowledge_preference": {"answer": acknowledge},
        "hallucinate_preference": {"answer": hallucinate},
        "helpful_response": {"answer": helpful},
    }


def _reference_bucket(violate, acknowledge, hallucinate, helpful):
    """The bucket implied by amazon-science/PrefEval analyze_errors()."""
    is_ack = "yes" in acknowledge.lower()
    is_hal = is_ack and "yes" in hallucinate.lower()
    is_vio = "yes" in violate.lower()
    is_unhelpful = "no" in helpful.lower()
    if is_unhelpful:
        return pref_classify.UNHELPFUL_RESPONSE
    if is_ack and not is_hal and is_vio:
        return pref_classify.INCONSISTENCY_VIOLATION
    if is_ack and is_hal and is_vio:
        return pref_classify.PREFERENCE_HALLUCINATION_VIOLATION
    if not is_ack and is_vio:
        return pref_classify.PREFERENCE_UNAWARE_VIOLATION
    return pref_classify.PERSONALIZED_RESPONSE


@pytest.mark.parametrize("answers", list(itertools.product(["Yes", "No"], repeat=4)))
def test_matches_reference_on_well_formed_answers(answers):
    assert pref_classify.classify_error_type(_judge(*answers)) == _reference_bucket(*answers)


@pytest.mark.parametrize(
    ("answers", "expected"),
    [
        (("yes", "no", "No", "yes"), pref_classify.PREFERENCE_UNAWARE_VIOLATION),
        (("Yes.", "No", "No", "Yes"), pref_classify.PREFERENCE_UNAWARE_VIOLATION),
        ((" YES ", "No", "No", "Yes"), pref_classify.PREFERENCE_UNAWARE_VIOLATION),
        (("Yes", "No", "No", "No"), pref_classify.UNHELPFUL_RESPONSE),
        (("Yes", "Yes", "Yes", "No"), pref_classify.UNHELPFUL_RESPONSE),
        (("Yes", "No", "Yes", "Yes"), pref_classify.PREFERENCE_UNAWARE_VIOLATION),
        (("No", "Yes", "Yes", "Yes"), pref_classify.PERSONALIZED_RESPONSE),
    ],
)
def test_case_and_precedence(answers, expected):
    assert pref_classify.classify_error_type(_judge(*answers)) == expected


@pytest.mark.parametrize(
    "answers",
    [
        ("", "", "", ""),
        ("Yes", "No", "No", ""),
        ("Maybe", "No", "No", "Yes"),
        ("Yes", "No", "No", None),
    ],
)
def test_unrecognized_answers_are_judge_failures(answers):
    assert pref_classify.classify_error_type(_judge(*answers)) == pref_classify.JUDGE_FAILURE


def test_missing_judge_key_is_a_failure():
    partial = {"violate_preference": {"answer": "Yes"}}
    assert pref_classify.classify_error_type(partial) == pref_classify.JUDGE_FAILURE


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("Yes", True),
        ("yes.", True),
        ("No", False),
        (" no", False),
        ("", None),
        (None, None),
        ("Unknown", None),
    ],
)
def test_parse_yes_no(answer, expected):
    assert pref_classify.parse_yes_no(answer) is expected
