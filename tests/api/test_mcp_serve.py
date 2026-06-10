"""
Unit tests for MOSMCPServer — specifically the search_memories tool.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


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
    result = await search_fn(
        query="q", user_id="u1", cube_ids=["c1", "c2"], filter={}
    )

    mock_mos.search.assert_called_once_with("q", "u1", ["c1", "c2"])
    assert "error" not in result
