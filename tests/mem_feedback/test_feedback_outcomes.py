"""Feedback is a memory operation with an optional, independently generated answer."""

from unittest.mock import Mock

import pytest

from memos.exceptions import GraphDBError, LLMError, MemOSError
from memos.mem_feedback.simple_feedback import SimpleMemFeedback


@pytest.fixture
def feedback():
    instance = SimpleMemFeedback(*(Mock() for _ in range(7)))
    instance._generate_answer = Mock(return_value="Corrected answer")
    instance.process_feedback_core = Mock(
        return_value={"record": {"add": [{"id": "created"}], "update": [{"id": "updated"}]}}
    )
    return instance


@pytest.mark.parametrize("failure", [ValueError("model"), TimeoutError("model"), OSError("model")])
def test_optional_answer_failure_preserves_committed_records(feedback, failure):
    feedback._generate_answer.side_effect = failure
    result = feedback.process_feedback("u", "cube", [], "feedback", corrected_answer=True)
    assert result == {
        "answer": "",
        "answer_status": "unavailable",
        "record": {"add": [{"id": "created"}], "update": [{"id": "updated"}]},
    }
    feedback.process_feedback_core.assert_called_once()


@pytest.mark.parametrize("answer", [None, "", "  ", {}, "Corrected answer"])
def test_answer_status_is_machine_readable(feedback, answer):
    feedback._generate_answer.return_value = answer
    result = feedback.process_feedback("u", "cube", [], "feedback", corrected_answer=True)
    valid = answer == "Corrected answer"
    assert result["answer_status"] == ("generated" if valid else "unavailable")
    assert result["answer"] == (answer if valid else "")


def test_no_answer_requested_does_not_call_model(feedback):
    result = feedback.process_feedback("u", "cube", [], "feedback")
    assert result["answer_status"] == "not_requested" and result["answer"] == ""
    feedback._generate_answer.assert_not_called()


@pytest.mark.parametrize(
    "failure", [GraphDBError("storage"), ValueError("storage input"), OSError("core")]
)
def test_core_failure_wins_even_if_answer_also_fails(feedback, failure, caplog):
    feedback._generate_answer.side_effect = ValueError("optional answer")
    feedback.process_feedback_core.side_effect = failure
    with pytest.raises(type(failure)) as caught:
        feedback.process_feedback("u", "cube", [], "feedback", corrected_answer=True)
    assert caught.value is failure
    assert "answer" in caplog.text.lower()
    feedback._generate_answer.assert_called_once()
    feedback.process_feedback_core.assert_called_once()


def test_invalid_model_memory_is_not_reported_as_caller_value_error():
    feedback = SimpleMemFeedback(*(Mock() for _ in range(7)))
    feedback._keyword_replace_judgement = Mock(return_value=None)
    feedback._feedback_judgement = Mock(
        return_value=[{"validity": "true", "corrected_info": "fact", "key": "k", "tags": 17}]
    )
    feedback._batch_embed = Mock(return_value=[[1.0]])
    feedback._feedback_memory = Mock()
    with pytest.raises(MemOSError, match="model"):
        feedback.process_feedback_core("u", "cube", [{"role": "user", "content": "old"}], "new")
    feedback._feedback_memory.assert_not_called()


def test_core_unexpected_failure_is_not_empty_success():
    feedback = SimpleMemFeedback(*(Mock() for _ in range(7)))
    feedback._keyword_replace_judgement = Mock(side_effect=OSError("required operation"))
    with pytest.raises(MemOSError):
        feedback.process_feedback_core("u", "cube", [], "feedback")


@pytest.mark.parametrize("outcome", [None, {}, ValueError("invalid model JSON")])
def test_required_judgement_failure_is_not_a_noop(outcome):
    feedback = SimpleMemFeedback(*(Mock() for _ in range(7)))
    feedback._keyword_replace_judgement = Mock(return_value=None)
    feedback._feedback_judgement = Mock(return_value=outcome)
    if isinstance(outcome, Exception):
        feedback._feedback_judgement.side_effect = outcome
    feedback._feedback_memory = Mock()
    with pytest.raises(LLMError, match="model"):
        feedback.process_feedback_core(
            "u", "cube", [{"role": "user", "content": "history"}], "feedback"
        )
    feedback._feedback_memory.assert_not_called()
