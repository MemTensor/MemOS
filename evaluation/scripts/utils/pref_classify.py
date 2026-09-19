"""Error-type classification for PrefEval judge answers.

Kept free of third-party imports so it can be unit tested without the
evaluation dependency group.
"""

from typing import Any


JUDGE_FAILURE = "Judge Failure"
PERSONALIZED_RESPONSE = "Personalized Response"
UNHELPFUL_RESPONSE = "Unhelpful Response"
PREFERENCE_UNAWARE_VIOLATION = "Preference-Unaware Violation"
PREFERENCE_HALLUCINATION_VIOLATION = "Preference Hallucination Violation"
INCONSISTENCY_VIOLATION = "Inconsistency Violation"

_JUDGE_KEYS = (
    "violate_preference",
    "acknowledge_preference",
    "hallucinate_preference",
    "helpful_response",
)


def parse_yes_no(answer: str | None) -> bool | None:
    """Map a judge answer to True (yes) or False (no).

    Returns None when the answer is missing or is neither yes nor no, for
    example the empty string that the judge call returns after an API error.
    """
    if answer is None:
        return None
    normalized = answer.strip().lower()
    if normalized.startswith("yes"):
        return True
    if normalized.startswith("no"):
        return False
    return None


def classify_error_type(evaluation_results: dict[str, Any]) -> str:
    """Classify one PrefEval sample from the four judge answers.

    Follows the reference implementation in amazon-science/PrefEval
    (generation_task/get_preference_following_accuracy_generation_task.py):
    an unhelpful response is an error on its own, the three violation
    buckets require a helpful response, and a hallucinated preference only
    counts when the preference was acknowledged. A missing or unrecognized
    judge answer is reported as a judge failure instead of being counted as a
    personalized response.
    """
    answers = {
        key: parse_yes_no(evaluation_results.get(key, {}).get("answer")) for key in _JUDGE_KEYS
    }
    if any(value is None for value in answers.values()):
        return JUDGE_FAILURE

    violate = answers["violate_preference"]
    acknowledge = answers["acknowledge_preference"]
    hallucinate = acknowledge and answers["hallucinate_preference"]
    unhelpful = not answers["helpful_response"]

    if unhelpful:
        return UNHELPFUL_RESPONSE
    if violate and not acknowledge:
        return PREFERENCE_UNAWARE_VIOLATION
    if violate and hallucinate:
        return PREFERENCE_HALLUCINATION_VIOLATION
    if violate:
        return INCONSISTENCY_VIOLATION
    return PERSONALIZED_RESPONSE
