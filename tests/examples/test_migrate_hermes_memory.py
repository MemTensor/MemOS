from examples.mcp_clients.hermes_agent.migrate_hermes_memory import build_memory_tool_call


def test_build_memory_tool_call_for_text_memory():
    content = "项目使用 Python 3.11。"

    payload = build_memory_tool_call(
        {"content": content, "layer": "text_mem", "source": "MEMORY.md"},
        request_id=7,
    )

    assert payload["id"] == 7
    assert payload["params"] == {
        "name": "add_memory",
        "arguments": {"memory_content": content},
    }


def test_build_memory_tool_call_for_preference_memory():
    content = "中文沟通，风格简洁直接。"

    payload = build_memory_tool_call(
        {"content": content, "layer": "pref_mem", "source": "USER.md"},
        request_id=8,
    )

    assert payload["id"] == 8
    assert payload["params"] == {
        "name": "add_preference_memory",
        "arguments": {"preference": content},
    }
    assert "[PREFERENCE]" not in payload["params"]["arguments"]["preference"]
