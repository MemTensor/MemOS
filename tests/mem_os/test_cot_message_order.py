from types import SimpleNamespace
from unittest.mock import Mock

from memos.mem_os.main import MOS


def test_cot_synthesis_keeps_history_and_instructions_in_shared_prefix():
    mos = MOS.__new__(MOS)
    mos.config = SimpleNamespace(enable_textual_memory=False, enable_activation_memory=False)
    mos.chat_llm = Mock()
    mos.chat_llm.generate.return_value = "answer"
    history_messages = [
        {"role": "user", "content": "previous question"},
        {"role": "assistant", "content": "previous answer"},
    ]
    history = SimpleNamespace(chat_history=history_messages)

    for turn in ("first", "second"):
        mos._generate_enhanced_response_with_context(
            original_query=f"{turn} user question",
            sub_questions=[f"{turn} subquestion"],
            sub_answers=[f"{turn} subanswer"],
            chat_history=history,
        )

    first, second = (call.args[0] for call in mos.chat_llm.generate.call_args_list)
    assert first[:-1] == second[:-1]
    assert first[1:-1] == history_messages
    assert [message["role"] for message in first] == ["system", "user", "assistant", "user"]
    assert "comprehensive response" in first[0]["content"]
    for turn, messages in (("first", first), ("second", second)):
        assert f"{turn} subquestion" in messages[-1]["content"]
        assert f"{turn} subanswer" in messages[-1]["content"]
        assert messages[-1]["content"].endswith(f"{turn} user question")
