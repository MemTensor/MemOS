import ast
from pathlib import Path
from typing import List


PRODUCT_MODELS = Path(__file__).resolve().parents[2] / "src/memos/api/product_models.py"


def _class_body(name: str) -> List[ast.stmt]:
    module = ast.parse(PRODUCT_MODELS.read_text())
    for node in module.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node.body
    raise AssertionError(f"{name} class not found")


def _field_description(class_name: str, field_name: str) -> str:
    for node in _class_body(class_name):
        if not isinstance(node, ast.AnnAssign) or not isinstance(node.target, ast.Name):
            continue
        if node.target.id != field_name:
            continue
        if not isinstance(node.value, ast.Call):
            raise AssertionError(f"{class_name}.{field_name} is not declared with Field")
        for keyword in node.value.keywords:
            if keyword.arg == "description":
                value = ast.literal_eval(keyword.value)
                return value.strip()
    raise AssertionError(f"{class_name}.{field_name} description not found")


def test_api_search_filter_description_is_explicit():
    source = PRODUCT_MODELS.read_text()

    assert "TODO: maybe add detailed description later" not in source

    description = _field_description("APISearchRequest", "filter")
    assert "metadata fields" in description
    assert "and" in description
    assert "or" in description
    assert "comparison operators" in description
    assert "session_id" in description
