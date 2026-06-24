import importlib.util

from pathlib import Path
from unittest.mock import MagicMock, call


PLUGIN_PATH = (
    Path(__file__).parents[2] / "examples/mcp_clients/hermes_agent/plugin/memos-memory/__init__.py"
)


def load_plugin():
    spec = importlib.util.spec_from_file_location("hermes_memos_plugin", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_pre_llm_call_returns_memory_context():
    plugin = load_plugin()
    plugin._CLIENT.search_memories = MagicMock(return_value=["Prefers concise answers"])

    result = plugin._on_pre_llm_call(user_message="How should you answer?", session_id="s1")

    assert result == {
        "context": "Relevant long-term memories from MemOS:\n- Prefers concise answers"
    }


def test_parse_sse_supports_multiline_data():
    plugin = load_plugin()
    payload = 'event: message\ndata: {"jsonrpc":"2.0","id":1,\n"result":{"content":[]}}\n\n'

    assert plugin.MemosMCPClient._parse_sse(payload) == {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"content": []},
    }


def test_pre_llm_call_fails_open():
    plugin = load_plugin()
    plugin._CLIENT.search_memories = MagicMock(side_effect=TimeoutError("offline"))

    assert plugin._on_pre_llm_call(user_message="hello", session_id="s1") is None


def test_post_llm_call_submits_user_assistant_pair():
    plugin = load_plugin()
    plugin._CLIENT.add_turn = MagicMock()

    plugin._submit_turn(
        session_id="s1",
        turn_id="t1",
        user_message="Remember this",
        assistant_response="I will",
    )

    plugin._CLIENT.add_turn.assert_called_once_with(
        session_id="s1",
        messages=[
            {"role": "user", "content": "Remember this"},
            {"role": "assistant", "content": "I will"},
        ],
    )


def test_post_llm_call_skips_duplicate_turn():
    plugin = load_plugin()
    plugin._CLIENT.add_turn = MagicMock()

    kwargs = {
        "session_id": "s1",
        "turn_id": "t1",
        "user_message": "Remember this",
        "assistant_response": "I will",
    }
    plugin._submit_turn(**kwargs)
    plugin._submit_turn(**kwargs)

    plugin._CLIENT.add_turn.assert_called_once()


def test_registers_pre_and_post_hooks():
    plugin = load_plugin()
    context = MagicMock()

    plugin.register(context)

    assert context.register_hook.call_args_list == [
        call("pre_llm_call", plugin._on_pre_llm_call),
        call("post_llm_call", plugin._on_post_llm_call),
    ]
