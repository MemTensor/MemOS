"""Regression tests for issue #2392.

Two public docstrings documented parameters that the AST no longer exposes
(``user_id`` on ``RedisPersistentUserManager.__init__``, ``merge_field`` on
``concat_original_source``). These tests fail loudly if anyone re-introduces
the mismatch by either:

- editing the body to add a parameter the docstring doesn't mention, or
- editing the docstring to claim a parameter the body no longer accepts.

The check parses the source file directly (so it sees the real signature
even when the function is wrapped by a decorator like
``@require_python_package``).
"""

from __future__ import annotations

import ast
import re

from pathlib import Path

from memos.mem_user.redis_persistent_user_manager import RedisPersistentUserManager
from memos.reranker.concat import concat_original_source


REPO_ROOT = Path(__file__).resolve().parents[1]


def _function_def_in_class(func, file_path: Path) -> ast.FunctionDef:
    """Parse the source file and return the ``__init__``/``def`` whose name
    matches ``func.__name__``, scoped to the class whose name matches
    ``func.__qualname__.split('.')[-2]``.
    """
    tree = ast.parse(file_path.read_text(encoding="utf-8"))
    qualname_parts = func.__qualname__.split(".")
    target_class = qualname_parts[-2] if len(qualname_parts) >= 2 else None
    target_name = func.__name__

    if target_class is not None:
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == target_class:
                for item in node.body:
                    if isinstance(item, ast.FunctionDef) and item.name == target_name:
                        return item
    return None


def _function_def_for_module_func(func, file_path: Path) -> ast.FunctionDef:
    """Locate a module-level function by name."""
    tree = ast.parse(file_path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == func.__name__:
            return node
    return None


def _signature_param_names(func) -> set[str]:
    # Walk back from func.__module__ to find the actual source file. This
    # works around decorators like ``@require_python_package`` that rewrite
    # ``__code__`` (so ``func.__code__.co_filename`` no longer points to the
    # original module).
    import importlib

    module = importlib.import_module(func.__module__)
    file_path = Path(getattr(module, "__file__", str(REPO_ROOT)))
    if not file_path.is_absolute():
        file_path = REPO_ROOT / file_path
    qualname_parts = func.__qualname__.split(".")
    if len(qualname_parts) >= 2:
        node = _function_def_in_class(func, file_path)
    else:
        node = _function_def_for_module_func(func, file_path)
    if node is None:
        # A silent empty-set return here would make both diff sets empty by
        # construction, so the parity assertions below could never fail —
        # the opposite of the "fail loudly" contract in the module docstring.
        raise AssertionError(
            f"Could not locate an AST definition for {func.__qualname__} in {file_path}; "
            "docstring/signature parity was not actually verified"
        )
    args = node.args
    params: set[str] = set()
    params.update(p.arg for p in args.posonlyargs)
    params.update(p.arg for p in args.args)
    params.update(p.arg for p in args.kwonlyargs)
    # ``self``/``cls`` never appear in the Args docstring block; drop them.
    params.discard("self")
    params.discard("cls")
    return params


def _docstring_param_names(func) -> set[str]:
    doc = func.__doc__ or ""
    args_match = re.search(
        r"Args:\s*\n(.*?)(?:\n\s*\n|\n\s*Returns:|\n\s*Raises:|\Z)", doc, re.DOTALL
    )
    if not args_match:
        return set()
    block = args_match.group(1)
    names: set[str] = set()
    for line in block.splitlines():
        m = re.match(r"\s*(\w+)\s*\(", line)
        if m:
            names.add(m.group(1))
    return names


def _diff_report(func) -> tuple[set[str], set[str]]:
    sig = _signature_param_names(func)
    doc = _docstring_param_names(func)
    return sig - doc, doc - sig


class TestDocstringSignatureParity:
    def test_redis_persistent_user_manager_init(self):
        only_in_sig, only_in_doc = _diff_report(RedisPersistentUserManager.__init__)
        assert not only_in_sig, (
            f"RedisPersistentUserManager.__init__ has parameters missing from "
            f"the docstring's Args block: {sorted(only_in_sig)}"
        )
        assert not only_in_doc, (
            f"RedisPersistentUserManager.__init__ docstring lists parameters "
            f"that are not in the signature: {sorted(only_in_doc)}"
        )

    def test_concat_original_source(self):
        only_in_sig, only_in_doc = _diff_report(concat_original_source)
        assert not only_in_sig, (
            f"concat_original_source has parameters missing from the docstring: "
            f"{sorted(only_in_sig)}"
        )
        assert not only_in_doc, (
            f"concat_original_source docstring lists parameters that are not in "
            f"the signature: {sorted(only_in_doc)}"
        )
