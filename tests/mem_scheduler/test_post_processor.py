"""
Unit tests for MemoryPostProcessor.

These tests verify the post-processing operations including memory enhancement,
filtering, and reranking.
"""

import pytest
from unittest.mock import Mock, MagicMock

from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.mem_scheduler.memory_manage_modules.post_processor import MemoryPostProcessor
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata


class TestMemoryPostProcessor:
    """Test suite for MemoryPostProcessor."""

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM instance."""
        llm = Mock()
        llm.generate = Mock(return_value='{"result": true, "reason": "test"}')
        return llm

    @pytest.fixture
    def mock_config(self):
        """Create a mock config instance."""
        config = Mock(spec=BaseSchedulerConfig)
        config.scheduler_retriever_batch_size = 10
        config.scheduler_retriever_enhance_retries = 2
        return config

    @pytest.fixture
    def processor(self, mock_llm, mock_config):
        """Create a MemoryPostProcessor instance."""
        return MemoryPostProcessor(process_llm=mock_llm, config=mock_config)

    @pytest.fixture
    def sample_memories(self):
        """Create sample memory items for testing."""
        return [
            TextualMemoryItem(
                memory="Python is a programming language",
                metadata=TextualMemoryMetadata(user_id="user1", memory_type="LongTermMemory")
            ),
            TextualMemoryItem(
                memory="JavaScript is also a programming language",
                metadata=TextualMemoryMetadata(user_id="user1", memory_type="LongTermMemory")
            ),
        ]

    def test_init(self, mock_llm, mock_config):
        """Test initialization of MemoryPostProcessor."""
        processor = MemoryPostProcessor(process_llm=mock_llm, config=mock_config)
        
        assert processor.process_llm is mock_llm
        assert processor.config is mock_config
        assert processor.filter_similarity_threshold == 0.75
        assert processor.filter_min_length_threshold == 6

    def test_evaluate_memory_answer_ability_true(self, processor, mock_llm):
        """Test evaluate_memory_answer_ability when memories can answer query."""
        mock_llm.generate.return_value = '{"result": true, "reason": "Memories contain relevant info"}'
        
        result = processor.evaluate_memory_answer_ability(
            query="What is Python?",
            memory_texts=["Python is a programming language"],
        )
        
        assert result is True
        assert mock_llm.generate.called

    def test_evaluate_memory_answer_ability_false(self, processor, mock_llm):
        """Test evaluate_memory_answer_ability when memories cannot answer query."""
        mock_llm.generate.return_value = '{"result": false, "reason": "No relevant info"}'
        
        result = processor.evaluate_memory_answer_ability(
            query="What is the capital of France?",
            memory_texts=["Python is a programming language"],
        )
        
        assert result is False

    def test_evaluate_memory_answer_ability_with_top_k(self, processor, mock_llm):
        """Test evaluate_memory_answer_ability with top_k limit."""
        mock_llm.generate.return_value = '{"result": true}'
        
        memories = ["memory 1", "memory 2", "memory 3", "memory 4", "memory 5"]
        processor.evaluate_memory_answer_ability(
            query="test query",
            memory_texts=memories,
            top_k=3,
        )
        
        # Verify only top 3 memories were used
        call_args = mock_llm.generate.call_args[0][0]
        prompt_content = call_args[0]["content"]
        # Should contain only 3 memories
        assert prompt_content.count("- memory") == 3

    def test_enhance_memories_with_query_empty(self, processor):
        """Test enhance_memories_with_query with empty memory list."""
        enhanced, success = processor.enhance_memories_with_query(
            query_history=["test query"],
            memories=[],
        )
        
        assert enhanced == []
        assert success is True

    def test_recall_for_missing_memories(self, processor, mock_llm):
        """Test recall_for_missing_memories returns hint and trigger flag."""
        mock_llm.generate.return_value = '{"hint": "search for Python basics", "trigger_recall": true}'
        
        hint, trigger = processor.recall_for_missing_memories(
            query="What is Python?",
            memories=["JavaScript is a language"],
        )
        
        assert hint == "search for Python basics"
        assert trigger is True

    def test_recall_for_missing_memories_no_hint(self, processor, mock_llm):
        """Test recall_for_missing_memories when no hint is provided."""
        mock_llm.generate.return_value = '{"hint": "", "trigger_recall": false}'
        
        hint, trigger = processor.recall_for_missing_memories(
            query="test query",
            memories=["sufficient memory"],
        )
        
        assert hint == ""
        assert trigger is False

    def test_rerank_memories_success(self, processor, mock_llm):
        """Test successful memory reranking."""
        original_memories = ["memory A", "memory B", "memory C"]
        mock_llm.generate.return_value = '{"new_order": [2, 0, 1], "reasoning": "C is most relevant"}'
        
        reranked, success = processor.rerank_memories(
            queries=["test query"],
            original_memories=original_memories,
            top_k=3,
        )
        
        assert success is True
        assert reranked == ["memory C", "memory A", "memory B"]

    def test_rerank_memories_failure_fallback(self, processor, mock_llm):
        """Test reranking fallback when LLM fails."""
        original_memories = ["memory A", "memory B", "memory C"]
        mock_llm.generate.return_value = '{"invalid": "response"}'  # Missing new_order
        
        reranked, success = processor.rerank_memories(
            queries=["test query"],
            original_memories=original_memories,
            top_k=2,
        )
        
        assert success is False
        assert reranked == ["memory A", "memory B"]  # Original order, truncated to top_k

    def test_rerank_memories_respects_top_k(self, processor, mock_llm):
        """Test that reranking respects top_k limit."""
        original_memories = ["A", "B", "C", "D", "E"]
        mock_llm.generate.return_value = '{"new_order": [4, 3, 2, 1, 0], "reasoning": "reversed"}'
        
        reranked, success = processor.rerank_memories(
            queries=["test"],
            original_memories=original_memories,
            top_k=3,
        )
        
        assert len(reranked) == 3
        assert reranked == ["E", "D", "C"]

    def test_process_and_rerank_memories(self, processor, mock_llm, sample_memories):
        """Test combined processing and reranking of memories."""
        mock_llm.generate.return_value = '{"new_order": [0, 1], "reasoning": "test"}'
        
        original = sample_memories[:1]
        new = sample_memories[1:]
        
        reranked, success = processor.process_and_rerank_memories(
            queries=["programming languages"],
            original_memory=original,
            new_memory=new,
            top_k=2,
        )
        
        # Should have combined and reranked both memories
        assert len(reranked) <= 2
        assert all(isinstance(m, TextualMemoryItem) for m in reranked)

    def test_filter_unrelated_memories_delegation(self, processor, sample_memories):
        """Test that filter_unrelated_memories delegates to MemoryFilter."""
        with Mock() as mock_memory_filter:
            processor.memory_filter = mock_memory_filter
            mock_memory_filter.filter_unrelated_memories = Mock(
                return_value=(sample_memories, True)
            )
            
            filtered, success = processor.filter_unrelated_memories(
                query_history=["test"],
                memories=sample_memories,
            )
            
            assert mock_memory_filter.filter_unrelated_memories.called
            assert filtered == sample_memories
            assert success is True

    def test_filter_redundant_memories_delegation(self, processor, sample_memories):
        """Test that filter_redundant_memories delegates to MemoryFilter."""
        with Mock() as mock_memory_filter:
            processor.memory_filter = mock_memory_filter
            mock_memory_filter.filter_redundant_memories = Mock(
                return_value=(sample_memories[:1], True)
            )
            
            filtered, success = processor.filter_redundant_memories(
                query_history=["test"],
                memories=sample_memories,
            )
            
            assert mock_memory_filter.filter_redundant_memories.called

    def test_filter_unrelated_and_redundant_memories_delegation(self, processor, sample_memories):
        """Test combined filtering delegation."""
        with Mock() as mock_memory_filter:
            processor.memory_filter = mock_memory_filter
            mock_memory_filter.filter_unrelated_and_redundant_memories = Mock(
                return_value=(sample_memories[:1], True)
            )
            
            filtered, success = processor.filter_unrelated_and_redundant_memories(
                query_history=["test"],
                memories=sample_memories,
            )
            
            assert mock_memory_filter.filter_unrelated_and_redundant_memories.called

    def test_split_batches(self):
        """Test _split_batches static method."""
        memories = [
            TextualMemoryItem(
                memory=f"memory {i}",
                metadata=TextualMemoryMetadata(user_id="user1", memory_type="LongTermMemory")
            )
            for i in range(25)
        ]
        
        batches = MemoryPostProcessor._split_batches(memories, batch_size=10)
        
        assert len(batches) == 3
        assert batches[0][0] == 0  # Start index
        assert batches[0][1] == 10  # End index
        assert len(batches[0][2]) == 10  # Batch size
        assert len(batches[2][2]) == 5  # Last batch partial


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
