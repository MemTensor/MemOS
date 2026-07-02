import ast
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[2] / "src/memos/mem_reader/strategy_struct.py"


def _get_llm_response_body():
    module = ast.parse(SOURCE.read_text())
    for node in module.body:
        if isinstance(node, ast.ClassDef) and node.name == "StrategyStructMemReader":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "_get_llm_response":
                    return item.body
    raise AssertionError("StrategyStructMemReader._get_llm_response not found")


def test_strategy_struct_reader_does_not_keep_dead_prompt_example_branch():
    body = _get_llm_response_body()
    names = {
        node.id
        for statement in body
        for node in ast.walk(statement)
        if isinstance(node, ast.Name)
    }
    attrs = {
        node.attr
        for statement in body
        for node in ast.walk(statement)
        if isinstance(node, ast.Attribute)
    }

    assert "remove_prompt_example" not in attrs
    assert "examples" not in names
