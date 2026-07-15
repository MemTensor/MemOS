import pytest

from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal
from memos.memories.textual.tree_text_memory.retrieve.task_goal_parser import TaskGoalParser


class MockLLM:
    def generate(self, messages):
        # Just return a fake JSON string
        return """
        {
            "memories": ["Cats are cute"],
            "keys": ["cats"],
            "tags": ["animal", "pet"],
            "goal_type": "fact"
        }
        """


def test_parse_fast_returns_expected():
    parser = TaskGoalParser()
    result = parser.parse("Tell me about cats", mode="fast")
    assert isinstance(result, ParsedTaskGoal)


def test_parse_fine_calls_llm_and_parses():
    mock_llm = MockLLM()
    parser = TaskGoalParser(llm=mock_llm)

    result = parser.parse("Tell me about cats", mode="fine")
    assert isinstance(result, ParsedTaskGoal)
    assert result.memories == ["Cats are cute"]
    assert "cats" in result.keys
    assert "animal" in result.tags
    assert result.goal_type == "fact"


def test_parse_response_invalid_json():
    parser = TaskGoalParser(llm=MockLLM())

    bad_response = "not a valid json"
    with pytest.raises(ValueError) as e:
        parser._parse_response(bad_response)
    assert "Failed to parse LLM output" in str(e.value)


def test_parse_fine_raises_without_llm():
    parser = TaskGoalParser(llm=None)
    with pytest.raises(ValueError) as e:
        parser.parse("Hello", mode="fine")
    assert "LLM not provided" in str(e.value)


def test_parse_raises_on_unknown_mode():
    parser = TaskGoalParser()
    with pytest.raises(ValueError) as e:
        parser.parse("Hi", mode="unknown")
    assert "Unknown mode" in str(e.value)
