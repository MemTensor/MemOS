"""
Unit tests for MOSMCPServer — specifically the search_memories tool.
"""

import asyncio
import json

from unittest.mock import MagicMock, patch

import pytest


def test_load_default_config_reads_embedding_dimension(monkeypatch):
    from memos.api.mcp_serve import load_default_config

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("EMBEDDING_DIMENSION", "1024")

    with patch("memos.api.mcp_serve.get_default") as get_default:
        get_default.return_value = (MagicMock(), MagicMock())
        load_default_config()

    assert get_default.call_args.kwargs["embedding_dimension"] == 1024


@pytest.fixture
def mock_mos():
    """Return a MagicMock standing in for a MOS instance."""
    mos = MagicMock()
    mos.search.return_value = {"text_mem": [], "act_mem": [], "para_mem": [], "pref_mem": []}
    return mos


@pytest.fixture
def mcp_server(mock_mos):
    """Create a MOSMCPServer with a pre-built MOS mock (skips heavy init)."""
    from memos.api.mcp_serve import MOSMCPServer

    server = MOSMCPServer.__new__(MOSMCPServer)
    server.mos_core = mock_mos
    server.mcp = MagicMock()

    # Collect the registered tool functions by intercepting mcp.tool()
    registered_tools: dict = {}

    def fake_tool():
        def decorator(fn):
            registered_tools[fn.__name__] = fn
            return fn

        return decorator

    server.mcp.tool = fake_tool
    server._setup_tools()
    server._tools = registered_tools
    return server


@pytest.mark.asyncio
async def test_search_memories_empty_filter_treated_as_none(mcp_server, mock_mos):
    """search_memories with filter={} must not raise and must call mos_core.search."""
    search_fn = mcp_server._tools["search_memories"]
    result = await search_fn(query="test query", filter={})

    mock_mos.search.assert_called_once_with("test query", None, None)
    assert "error" not in result


@pytest.mark.asyncio
async def test_search_memories_none_filter(mcp_server, mock_mos):
    """search_memories with filter=None behaves identically to filter={}."""
    search_fn = mcp_server._tools["search_memories"]
    result = await search_fn(query="test query", filter=None)

    mock_mos.search.assert_called_once_with("test query", None, None)
    assert "error" not in result


@pytest.mark.asyncio
async def test_search_memories_no_filter_arg(mcp_server, mock_mos):
    """search_memories without filter kwarg uses the default (None)."""
    search_fn = mcp_server._tools["search_memories"]
    result = await search_fn(query="test query")

    mock_mos.search.assert_called_once_with("test query", None, None)
    assert "error" not in result


@pytest.mark.asyncio
async def test_search_memories_passes_user_and_cube_ids(mcp_server, mock_mos):
    """search_memories forwards user_id and cube_ids to mos_core.search."""
    search_fn = mcp_server._tools["search_memories"]
    result = await search_fn(query="q", user_id="u1", cube_ids=["c1", "c2"], filter={})

    mock_mos.search.assert_called_once_with("q", "u1", ["c1", "c2"])
    assert "error" not in result


@pytest.mark.asyncio
async def test_add_memory_forwards_session_id(mcp_server, mock_mos):
    add_memory = mcp_server._tools["add_memory"]

    result = await add_memory(
        messages=[{"role": "user", "content": "hello"}],
        session_id="hermes-session",
    )

    mock_mos.add.assert_called_once_with(
        messages=[{"role": "user", "content": "hello"}],
        memory_content=None,
        doc_path=None,
        mem_cube_id=None,
        user_id=None,
        session_id="hermes-session",
    )
    assert result == "Memory added successfully"


@pytest.mark.asyncio
async def test_add_preference_memory_writes_structured_preference(mcp_server, mock_mos):
    preference = "中文沟通，风格简洁直接。"
    cube = MagicMock()
    cube.text_mem.embedder.embed.return_value = [[0.1, 0.2, 0.3]]
    cube.text_mem.add.return_value = ["preference-id"]
    mock_mos.user_id = "default_user"
    mock_mos.session_id = "default_session"
    mock_mos.mem_cubes = {"cube_default_user": cube}
    mock_mos.user_manager.get_user_cubes.return_value = [MagicMock(cube_id="cube_default_user")]

    add_preference = mcp_server._tools["add_preference_memory"]
    result = await add_preference(
        preference=preference,
        topic="communication",
        reasoning="Imported from Hermes USER.md",
    )

    cube.text_mem.embedder.embed.assert_called_once_with([preference])
    added_item = cube.text_mem.add.call_args.args[0][0]
    assert added_item.memory == preference
    assert added_item.metadata.memory_type == "PreferenceMemory"
    assert added_item.metadata.preference_type == "explicit_preference"
    assert added_item.metadata.preference == preference
    assert added_item.metadata.topic == "communication"
    assert added_item.metadata.reasoning == "Imported from Hermes USER.md"
    assert result == "Preference memory added successfully: preference-id"


@pytest.mark.asyncio
async def test_add_preference_memory_notifies_enabled_scheduler(mcp_server, mock_mos):
    cube = MagicMock()
    cube.text_mem.embedder.embed.return_value = [[0.1, 0.2, 0.3]]
    cube.text_mem.add.return_value = ["preference-id"]
    mock_mos.user_id = "default_user"
    mock_mos.session_id = "default_session"
    mock_mos.mem_cubes = {"cube_default_user": cube}
    mock_mos.user_manager.get_user_cubes.return_value = [MagicMock(cube_id="cube_default_user")]
    mock_mos.enable_mem_scheduler = True

    add_preference = mcp_server._tools["add_preference_memory"]
    await add_preference(preference="Prefer concise answers")

    submitted = mock_mos.mem_scheduler.submit_messages.call_args.kwargs["messages"][0]
    assert submitted.label == "add"
    assert submitted.user_id == "default_user"
    assert submitted.mem_cube_id == "cube_default_user"
    assert submitted.content == '["preference-id"]'


@pytest.mark.asyncio
async def test_add_preference_memory_rejects_blank_text(mcp_server, mock_mos):
    cube = MagicMock()
    mock_mos.user_id = "default_user"
    mock_mos.session_id = "default_session"
    mock_mos.mem_cubes = {"cube_default_user": cube}
    mock_mos.user_manager.get_user_cubes.return_value = [MagicMock(cube_id="cube_default_user")]

    add_preference = mcp_server._tools["add_preference_memory"]
    result = await add_preference(preference="   ")

    cube.text_mem.add.assert_not_called()
    assert result == "Error adding preference memory: preference must not be blank"


@pytest.mark.asyncio
async def test_add_preference_memory_runs_sync_embedder_outside_event_loop(mcp_server, mock_mos):
    class LoopSensitiveEmbedder:
        def embed(self, texts):
            return asyncio.run(asyncio.sleep(0, result=[[0.1, 0.2, 0.3]]))

    cube = MagicMock()
    cube.text_mem.embedder = LoopSensitiveEmbedder()
    cube.text_mem.add.return_value = ["preference-id"]
    mock_mos.user_id = "default_user"
    mock_mos.session_id = "default_session"
    mock_mos.mem_cubes = {"cube_default_user": cube}
    mock_mos.user_manager.get_user_cubes.return_value = [MagicMock(cube_id="cube_default_user")]

    add_preference = mcp_server._tools["add_preference_memory"]
    result = await add_preference(preference="Prefer concise answers")

    assert result == "Preference memory added successfully: preference-id"


@pytest.mark.asyncio
async def test_add_raw_conversation_turn_writes_archived_raw_memory(mcp_server, mock_mos):
    cube = MagicMock()
    cube.text_mem.embedder.embed.return_value = [[0.1, 0.2, 0.3]]
    mock_mos.user_id = "default_user"
    mock_mos.mem_cubes = {"cube_default_user": cube}
    mock_mos.user_manager.get_user_cubes.return_value = [MagicMock(cube_id="cube_default_user")]

    add_raw = mcp_server._tools["add_raw_conversation_turn"]
    result = await add_raw(
        raw_turn_json=json.dumps(
            {
                "turn_id": "s1:1:2",
                "messages": [
                    {"role": "user", "content": "你好"},
                    {"role": "assistant", "content": "你好，我可以帮你。"},
                ],
                "metadata": {
                    "source_agent": "hermes_desktop",
                    "platform": "tui",
                    "status": "archived",
                },
            },
            ensure_ascii=False,
        ),
        session_id="s1",
    )

    cube.text_mem.embedder.embed.assert_called_once()
    cube.text_mem.add.assert_not_called()
    cube.text_mem.graph_store.add_node.assert_called_once()
    _, memory_text, metadata = cube.text_mem.graph_store.add_node.call_args.args
    assert metadata["memory_type"] == "RawConversationTurn"
    assert metadata["status"] == "archived"
    assert metadata["source"] == "conversation"
    assert metadata["source_agent"] == "hermes_desktop"
    assert metadata["session_id"] == "s1"
    assert "user: 你好" in memory_text
    assert "assistant: 你好，我可以帮你。" in memory_text
    assert result.startswith("Raw conversation turn added successfully: ")


@pytest.mark.asyncio
async def test_process_raw_conversation_turns_submits_mem_read_batch(mcp_server, mock_mos):
    cube = MagicMock()
    cube.text_mem.graph_store.config.user_name = "memosdefaultuser"
    mock_mos.user_id = "default_user"
    mock_mos.mem_cubes = {"cube_default_user": cube}
    mock_mos.user_manager.get_user_cubes.return_value = [MagicMock(cube_id="cube_default_user")]
    mock_mos.enable_mem_scheduler = True

    process_raw = mcp_server._tools["process_raw_conversation_turns"]
    result = await process_raw(
        raw_memory_ids_json=json.dumps(["raw-1", "raw-2"]),
        session_id="hermes-session",
    )

    submitted = mock_mos.mem_scheduler.submit_messages.call_args.kwargs["messages"][0]
    assert submitted.label == "mem_read"
    assert submitted.content == '["raw-1", "raw-2"]'
    assert submitted.user_id == "default_user"
    assert submitted.mem_cube_id == "cube_default_user"
    assert submitted.session_id == "hermes-session"
    assert submitted.user_name == "memosdefaultuser"
    assert result == "Submitted 2 raw conversation turns for scheduler processing"
