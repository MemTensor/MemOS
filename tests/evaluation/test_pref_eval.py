import importlib.util
import os
import subprocess
import sys
import xml.etree.ElementTree as ET

from collections import Counter
from pathlib import Path
from zipfile import ZipFile

import pytest


MODULE_PATH = Path(__file__).resolve().parents[2] / "evaluation/scripts/PrefEval/pref_eval.py"
CATEGORIES = (
    "Preference-Unaware Violation",
    "Preference Hallucination Violation",
    "Inconsistency Violation",
    "Unhelpful Response",
    "Personalized Response",
    "Judge Failure",
)
XML_NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


@pytest.fixture
def evaluation_dependencies():
    for dependency in ("pandas", "xlsxwriter", "dotenv", "openai", "tqdm"):
        pytest.importorskip(dependency, reason="PrefEval requires optional evaluation dependencies")


@pytest.fixture
def pref_eval(evaluation_dependencies, monkeypatch):
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda: False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.syspath_prepend(str(MODULE_PATH.parents[1]))
    previous_utils = {
        name: module
        for name, module in sys.modules.items()
        if name == "utils" or name.startswith("utils.")
    }
    for name in previous_utils:
        del sys.modules[name]
    try:
        spec = importlib.util.spec_from_file_location("pref_eval_under_test", MODULE_PATH)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        yield module
    finally:
        for name in list(sys.modules):
            if name == "utils" or name.startswith("utils."):
                del sys.modules[name]
        sys.modules.update(previous_utils)


@pytest.mark.parametrize("conflict", ["module", "package"])
def test_cli_help_uses_local_utils(evaluation_dependencies, tmp_path, conflict):
    if conflict == "module":
        unrelated_utils = tmp_path / "utils.py"
    else:
        (tmp_path / "utils").mkdir()
        unrelated_utils = tmp_path / "utils/__init__.py"
    unrelated_utils.write_text('raise RuntimeError("Unrelated utils was imported")\n')
    env = {
        **os.environ,
        "PYTHONPATH": str(tmp_path),
        "PYTHON_DOTENV_DISABLED": "1",
    }
    env.pop("OPENAI_API_KEY", None)
    env.pop("OPENAI_API_BASE", None)

    result = subprocess.run(
        [sys.executable, str(MODULE_PATH), "--help"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "--input" in result.stdout
    assert "--concurrency-limit" in result.stdout


def _read_workbook(path):
    with ZipFile(path) as workbook:
        shared = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
        styles = ET.fromstring(workbook.read("xl/styles.xml"))
    strings = ["".join(item.itertext()) for item in shared.findall("s:si", XML_NS)]
    number_formats = {0: "General", 2: "0.00"}
    number_formats.update(
        {
            int(item.attrib["numFmtId"]): item.attrib["formatCode"]
            for item in styles.findall("s:numFmts/s:numFmt", XML_NS)
        }
    )
    cell_styles = styles.findall("s:cellXfs/s:xf", XML_NS)
    fonts = styles.findall("s:fonts/s:font", XML_NS)
    values, formats, bold_cells, wrapped_cells = {}, {}, set(), set()
    for cell in sheet.findall("s:sheetData/s:row/s:c", XML_NS):
        address = cell.attrib["r"]
        value = cell.find("s:v", XML_NS).text
        values[address] = strings[int(value)] if cell.get("t") == "s" else float(value)
        style = cell_styles[int(cell.get("s", "0"))]
        formats[address] = number_formats[int(style.attrib["numFmtId"])]
        if fonts[int(style.attrib["fontId"])].find("s:b", XML_NS) is not None:
            bold_cells.add(address)
        alignment = style.find("s:alignment", XML_NS)
        if alignment is not None and alignment.get("wrapText") == "1":
            wrapped_cells.add(address)
    return values, formats, bold_cells, wrapped_cells


@pytest.mark.parametrize(
    "counts",
    [
        pytest.param((10, 15, 20, 5, 30, 20), id="mixed"),
        pytest.param((1, 2, 3, 4, 10, 0), id="no-judge-failures"),
        pytest.param((0, 0, 0, 0, 0, 3), id="all-judge-failures"),
        pytest.param((0, 0, 0, 0, 0, 0), id="empty"),
    ],
)
def test_excel_summary_preserves_all_categories_and_metrics(pref_eval, tmp_path, counts):
    total = sum(counts)
    counter = Counter(
        {category: count for category, count in zip(CATEGORIES, counts, strict=True) if count}
    )
    summary = pref_eval.log_summary(counter, total)
    output = tmp_path / "summary.xlsx"

    pref_eval.generate_excel_summary(
        summary,
        avg_search_time=2.345,
        avg_context_tokens=123.5,
        avg_add_time=1.234,
        output_excel_file=str(output),
        model_name="test-model",
    )

    values, formats, bold_cells, wrapped_cells = _read_workbook(output)
    assert all(f"{column}1" in wrapped_cells for column in "ABCDEFGHIJ")
    assert values["G1"] == "Judge Failure\n评判失败"
    assert values["A2"] == "test-model"
    percentages = [values[f"{column}2"] for column in "BCDEFG"]
    expected = [count / total if total else 0 for count in counts]
    assert percentages == pytest.approx(expected)
    assert sum(percentages) == pytest.approx(1 if total else 0)
    assert all(formats[f"{column}2"] == "0.0%" for column in "BCDEFG")
    assert "F2" in bold_cells
    assert [values[f"{column}1"] for column in "HIJ"] == ["context token", "Time添加", "Time搜索"]
    assert values["H2"] == 123.5
    assert formats["H2"] == "0.00"
    assert values["I2"] == "1.23s"
    assert values["J2"] == "2.35s"
