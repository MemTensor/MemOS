from unittest.mock import Mock

from memos.mem_feedback.feedback import MemFeedback


def test_process_feedback_runs_answer_and_core_workflows():
    feedback = MemFeedback.__new__(MemFeedback)
    feedback._generate_answer = Mock(return_value="corrected answer")
    feedback.process_feedback_core = Mock(
        return_value={"record": {"add": [{"id": "memory-1"}], "update": []}}
    )

    chat_history = [{"role": "user", "content": "The response was too long."}]
    info = {"source": "unit-test"}

    result = feedback.process_feedback(
        "user-1",
        "alice",
        chat_history,
        "Please remember that I prefer concise answers.",
        info,
        corrected_answer=True,
        session_id="session-1",
        task_id="task-1",
    )

    assert result == {
        "answer": "corrected answer",
        "record": {"add": [{"id": "memory-1"}], "update": []},
    }
    feedback._generate_answer.assert_called_once_with(
        chat_history,
        "Please remember that I prefer concise answers.",
        corrected_answer=True,
    )
    feedback.process_feedback_core.assert_called_once_with(
        "user-1",
        "alice",
        chat_history,
        "Please remember that I prefer concise answers.",
        info,
        corrected_answer=True,
        session_id="session-1",
        task_id="task-1",
    )
