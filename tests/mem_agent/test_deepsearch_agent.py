"""Simplified unit tests for DeepSearchAgent - focusing on core functionality."""

import uuid

from unittest.mock import MagicMock, patch

import pytest

from memos.configs.mem_agent import DeepSearchAgentConfig
from memos.mem_agent.deepsearch_agent import (
    DeepSearchMemAgent,
    JSONResponseParser,
)
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata


class TestJSONResponseParser:
    """Test JSONResponseParser class."""

    def test_parse_clean_json(self):
        """Test parsing clean JSON response."""
        response = '{"status": "sufficient", "reasoning": "test"}'
        result = JSONResponseParser.parse(response)
        assert result == {"status": "sufficient", "reasoning": "test"}

    def test_parse_json_with_code_blocks(self):
        """Test parsing JSON wrapped in code blocks."""
        response = '```json\n{"status": "sufficient", "reasoning": "test"}\n```'
        result = JSONResponseParser.parse(response)
        assert result == {"status": "sufficient", "reasoning": "test"}

    def test_parse_invalid_json_raises_error(self):
        """Test that invalid JSON raises ValueError."""
        with pytest.raises(ValueError, match="Cannot parse JSON response"):
            JSONResponseParser.parse("This is not JSON at all")


class TestDeepSearchMemAgent:
    """Test DeepSearchMemAgent core functionality."""

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM."""
        mock = MagicMock()
        mock.generate.return_value = "Generated answer"
        return mock

    @pytest.fixture
    def mock_memory_retriever(self):
        """Create a mock memory retriever."""
        mock = MagicMock()
        memory_items = [
            TextualMemoryItem(
                id=str(uuid.uuid4()),
                memory="Python is a programming language",
                metadata=TextualMemoryMetadata(type="fact"),
            ),
            TextualMemoryItem(
                id=str(uuid.uuid4()),
                memory="Python was created by Guido van Rossum",
                metadata=TextualMemoryMetadata(type="fact"),
            ),
        ]
        mock.search.return_value = memory_items
        return mock

    @pytest.fixture
    def config(self):
        """Create DeepSearchAgentConfig."""
        return DeepSearchAgentConfig(agent_name="TestDeepSearch", max_iterations=3, timeout=30)

    @pytest.fixture
    def agent(self, mock_llm, mock_memory_retriever, config):
        """Create DeepSearchMemAgent instance."""
        agent = DeepSearchMemAgent(
            llm=mock_llm, memory_retriever=mock_memory_retriever, config=config
        )
        # Mock the sub-agents to avoid complex interactions
        agent.query_rewriter.run = MagicMock(return_value="Rewritten query")
        agent.reflector.run = MagicMock(
            return_value={
                "status": "sufficient",
                "reasoning": "Enough info",
                "missing_entities": [],
            }
        )
        return agent

    def test_init_with_config(self, mock_llm, mock_memory_retriever, config):
        """Test DeepSearchMemAgent initialization with config."""
        agent = DeepSearchMemAgent(mock_llm, mock_memory_retriever, config)
        assert agent.llm == mock_llm
        assert agent.memory_retriever == mock_memory_retriever
        assert agent.config == config
        assert agent.max_iterations == 3
        assert agent.timeout == 30

    def test_init_without_config(self, mock_llm, mock_memory_retriever):
        """Test DeepSearchMemAgent initialization without config."""
        agent = DeepSearchMemAgent(mock_llm, mock_memory_retriever)
        assert isinstance(agent.config, DeepSearchAgentConfig)
        assert agent.config.agent_name == "DeepSearchMemAgent"

    def test_run_no_llm_raises_error(self, config):
        """Test that running without LLM raises RuntimeError."""
        agent = DeepSearchMemAgent(llm=None, config=config)
        with pytest.raises(RuntimeError, match="LLM not initialized"):
            agent.run("test query")

    def test_run_returns_memories_when_no_generated_answer(self, agent, mock_memory_retriever):
        """Test run returns memories when generated_answer is not requested."""
        result = agent.run("What is Python?", generated_answer=False)

        assert isinstance(result, list)
        assert len(result) == 2
        assert all(isinstance(item, TextualMemoryItem) for item in result)
        agent.query_rewriter.run.assert_called_once()

    def test_run_returns_answer_when_generated_answer(self, agent, mock_llm):
        """Test run returns generated answer when requested."""
        result = agent.run("What is Python?", generated_answer=True)

        assert isinstance(result, str)
        assert result == "Generated answer"
        mock_llm.generate.assert_called_once()

    def test_run_with_user_id(self, agent, mock_memory_retriever):
        """Test run with user_id."""
        agent.run("What is Python?", user_id="user123", generated_answer=False)

        # Check that user_id was passed to search
        call_kwargs = mock_memory_retriever.search.call_args[1]
        assert call_kwargs.get("user_name") == "user123"

    def test_run_no_search_results(self, agent, mock_memory_retriever):
        """Test behavior when search returns no results."""
        mock_memory_retriever.search.return_value = []

        result = agent.run("What is Python?", generated_answer=False)

        assert result == []

    def test_remove_duplicate_memories(self, agent):
        """Test removing duplicate memories."""
        mem_id1 = str(uuid.uuid4())
        mem_id2 = str(uuid.uuid4())
        mem_id3 = str(uuid.uuid4())

        memories = [
            TextualMemoryItem(
                id=mem_id1, memory="Same content", metadata=TextualMemoryMetadata(type="fact")
            ),
            TextualMemoryItem(
                id=mem_id2,
                memory="Different content",
                metadata=TextualMemoryMetadata(type="fact"),
            ),
            TextualMemoryItem(
                id=mem_id3, memory="Same content", metadata=TextualMemoryMetadata(type="fact")
            ),
        ]

        result = agent._remove_duplicate_memories(memories)

        assert len(result) == 2
        assert result[0].id == mem_id1
        assert result[1].id == mem_id2

    def test_generate_final_answer(self, agent, mock_llm):
        """Test final answer generation."""
        memory_items = [
            TextualMemoryItem(
                id=str(uuid.uuid4()),
                memory="Python is a language",
                metadata=TextualMemoryMetadata(type="fact"),
            )
        ]
        context = ["Python is a programming language"]

        result = agent._generate_final_answer("What is Python?", memory_items, context)

        assert result == "Generated answer"
        mock_llm.generate.assert_called_once()

    def test_generate_final_answer_with_missing_info(self, agent, mock_llm):
        """Test final answer generation with missing info."""
        result = agent._generate_final_answer(
            "What is Python?", [], [], missing_info="Version details not found"
        )

        assert result == "Generated answer"
        call_args = mock_llm.generate.call_args[0][0]
        assert "Version details not found" in call_args[0]["content"]

    def test_generate_final_answer_llm_error(self, agent, mock_llm):
        """Test final answer generation handles LLM errors."""
        mock_llm.generate.side_effect = Exception("LLM error")

        result = agent._generate_final_answer("What is Python?", [], [])

        assert "error" in result.lower()
        assert "What is Python?" in result

    def test_perform_memory_search_no_retriever(self, mock_llm, config):
        """Test memory search when retriever is not configured."""
        agent = DeepSearchMemAgent(mock_llm, memory_retriever=None, config=config)
        result = agent._perform_memory_search("test query")

        assert result == []

    def test_integration_full_pipeline(self, mock_llm, mock_memory_retriever, config):
        """Test full pipeline integration."""
        agent = DeepSearchMemAgent(mock_llm, mock_memory_retriever, config)

        with (
            patch.object(agent.query_rewriter, "run", return_value="Rewritten query"),
            patch.object(
                agent.reflector,
                "run",
                return_value={
                    "status": "sufficient",
                    "reasoning": "Info is sufficient",
                    "missing_entities": [],
                },
            ),
        ):
            result = agent.run(
                "What is Python?", user_id="user123", history=[], generated_answer=True
            )

            assert isinstance(result, str)
            assert result == "Generated answer"
            mock_memory_retriever.search.assert_called()
            mock_llm.generate.assert_called()
