from unittest.mock import Mock

from memos.mem_feedback.feedback import MemFeedback
from memos.memories.textual.item import TextualMemoryItem
from memos.templates.mem_feedback_prompts import (
    OPERATION_UPDATE_JUDGEMENT,
    OPERATION_UPDATE_JUDGEMENT_ZH,
)


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


def test_standard_operations_downgrades_large_update_to_add():
    feedback = MemFeedback.__new__(MemFeedback)
    memory_id = "8583d7dd-28ba-422c-a9e7-0cd2ec90bc6c"
    old_memory = "用户喜欢简洁的技术文档。"
    new_memory = "完全不同的新事实，涉及商城订单售后调价风险、退款金额差异和业务确认事项。"
    current_memories = [TextualMemoryItem(id=memory_id, memory=old_memory)]

    operations = feedback.standard_operations(
        [
            {
                "id": memory_id,
                "text": new_memory,
                "operation": "UPDATE",
                "old_memory": old_memory,
            }
        ],
        current_memories,
    )

    assert operations == [{"operation": "ADD", "_downgraded_from_update": True}]


def test_standard_operations_keeps_downgraded_add_when_other_updates_exist():
    feedback = MemFeedback.__new__(MemFeedback)
    downgraded_id = "8583d7dd-28ba-422c-a9e7-0cd2ec90bc6c"
    update_id = "35098647-1d67-4a29-aae8-134fefc2f6b0"
    current_memories = [
        TextualMemoryItem(id=downgraded_id, memory="用户喜欢简洁的技术文档。"),
        TextualMemoryItem(id=update_id, memory="用户在A公司工作。"),
    ]

    operations = feedback.standard_operations(
        [
            {
                "id": downgraded_id,
                "text": "完全不同的新事实，涉及商城订单售后调价风险、退款金额差异和业务确认事项。",
                "operation": "UPDATE",
                "old_memory": "用户喜欢简洁的技术文档。",
            },
            {
                "id": update_id,
                "text": "用户在B公司工作。",
                "operation": "UPDATE",
                "old_memory": "用户在A公司工作。",
            },
        ],
        current_memories,
    )

    assert {"operation": "ADD", "_downgraded_from_update": True} in operations
    assert any(
        item.get("operation") == "UPDATE" and item.get("id") == update_id for item in operations
    )


def test_update_judgement_prompt_omits_memory_text_from_response_schema():
    for prompt in [OPERATION_UPDATE_JUDGEMENT, OPERATION_UPDATE_JUDGEMENT_ZH]:
        output_section = prompt.split("Output Format")[-1].split("Example 1")[0]
        output_section = output_section.split("输出格式")[-1].split("示例1")[0]

        assert '"reason"' in output_section
        assert '"text"' not in output_section
        assert '"old_memory"' not in output_section
