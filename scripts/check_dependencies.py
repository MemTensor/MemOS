import ast
import importlib
import sys

from pathlib import Path


EXCLUDE_MODULES = {"memos"}  # Exclude from import checks (e.g., our own package)
PYTHON_PACKAGE_DIR = Path("src/memos")


def extract_top_level_modules(tree: ast.Module) -> set[str]:
    """
    Extract all top-level imported modules (excluding relative imports).
    """
    modules = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            # Collect absolute imports only
            for alias in node.names:
                modules.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules.add(node.module.split(".")[0])
    return modules


def check_importable(modules: set[str], filename: str) -> list[str]:
    """
    Attempt to import each module in the current environment.
    Return a list of modules that fail to import.
    """
    failed = []
    for mod in sorted(modules):
        if mod in EXCLUDE_MODULES:
            # Skip excluded modules such as your own package
            continue
        try:
            importlib.import_module(mod)
        except ModuleNotFoundError:
            failed.append(mod)
        except Exception as e:
            print(
                f"⚠️ Warning: Importing module '{mod}' from {filename} raised unexpected error: {e}"
            )
    return failed


def main():
    py_files = list(PYTHON_PACKAGE_DIR.rglob("*.py"))

    has_error = False

    for py_file in py_files:
        try:
            source = py_file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(py_file))
        except SyntaxError as e:
            print(f"❌ Syntax error in {py_file}: {e}")
            has_error = True
            continue

        modules = extract_top_level_modules(tree)
        failed_imports = check_importable(modules, str(py_file))

        for mod in failed_imports:
            print(f"❌ {py_file}: Top-level import of unavailable module '{mod}'")

        if failed_imports:
            has_error = True

    if has_error:
        print(
            "\n💥 Top-level imports failed. These modules may not be main dependencies."
            " Try moving the imports to a function or class scope, and decorate it with @require_python_package."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
