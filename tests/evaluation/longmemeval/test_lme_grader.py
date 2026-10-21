"""Integration test for `lme_grader` against a mocked OpenAI client.

Repro from issue #2525: a judge reply that follows the prompt (one sentence
of reasoning then a JSON label) must be graded, not dropped. We stub out the
heavy eval-only dependencies (bert_score / sentence_transformers / rouge_score)
so the test runs on the standard `make test` extras without pulling in
`poetry install --with eval`.
"""

from __future__ import annotations

import importlib
import os
import sys
import types

from unittest import mock

import pytest


_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_EVAL_SCRIPTS = os.path.join(_REPO_ROOT, "evaluation", "scripts")
_LME_DIR = os.path.join(_EVAL_SCRIPTS, "longmemeval")


def _install_heavy_stubs() -> list[str]:
    """Install MagicMock stubs for the eval-only deps that `lme_eval` imports
    at module load time. Returns the list of stub names (for cleanup)."""
    stubs: dict[str, types.ModuleType] = {}

    # bert_score exports a function `score` imported as `score as bert_score`.
    bert_score_mod = types.ModuleType("bert_score")
    bert_score_mod.score = mock.MagicMock(return_value=(None, None, None))
    stubs["bert_score"] = bert_score_mod

    # sentence_transformers.SentenceTransformer is called at module import time.
    st_mod = types.ModuleType("sentence_transformers")
    st_mod.SentenceTransformer = mock.MagicMock(return_value=mock.MagicMock())
    stubs["sentence_transformers"] = st_mod

    # rouge_score.rouge_scorer.RougeScorer is used by calculate_rouge_scores.
    rouge_score_mod = types.ModuleType("rouge_score")
    rouge_scorer_mod = types.ModuleType("rouge_score.rouge_scorer")
    rouge_scorer_mod.RougeScorer = mock.MagicMock()
    rouge_score_mod.rouge_scorer = rouge_scorer_mod
    stubs["rouge_score"] = rouge_score_mod
    stubs["rouge_score.rouge_scorer"] = rouge_scorer_mod

    for name, mod in stubs.items():
        sys.modules.setdefault(name, mod)
    return list(stubs)


@pytest.fixture(scope="module")
def lme_eval_module():
    """Import `evaluation/scripts/longmemeval/lme_eval.py` with heavy deps stubbed."""
    installed = _install_heavy_stubs()
    for p in (_EVAL_SCRIPTS, _LME_DIR):
        if p not in sys.path:
            sys.path.insert(0, p)
    try:
        if "lme_eval" in sys.modules:
            del sys.modules["lme_eval"]
        module = importlib.import_module("lme_eval")
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"Cannot import lme_eval even with stubs: {exc}")
    try:
        yield module
    finally:
        # Only clean up what we actually added to sys.modules.
        for name in installed:
            if (
                sys.modules.get(name) is not None
                and isinstance(sys.modules[name], types.ModuleType)
                and sys.modules[name].__name__ == name
            ):
                # don't aggressively delete; other tests may want them cached
                pass


def _mock_client_returning(content: str) -> mock.MagicMock:
    client = mock.MagicMock()
    completion = mock.MagicMock()
    completion.choices = [mock.MagicMock()]
    completion.choices[0].message.content = content
    client.chat.completions.create.return_value = completion
    return client


def test_lme_grader_accepts_prose_plus_json_from_issue_2525(lme_eval_module):
    """The exact string in the bug report must grade CORRECT, not blow up."""
    content = 'The generated answer matches the gold answer.\n{"label": "CORRECT"}'
    client = _mock_client_returning(content)

    result = lme_eval_module.lme_grader(
        client,
        question="What degree did I graduate with?",
        golden_answer="Business Administration",
        response="Business Administration",
    )
    assert result is True


def test_lme_grader_accepts_raw_json(lme_eval_module):
    client = _mock_client_returning('{"label": "CORRECT"}')
    assert lme_eval_module.lme_grader(client, question="q", golden_answer="g", response="g") is True


def test_lme_grader_marks_wrong(lme_eval_module):
    content = 'Different topic from the gold answer.\n{"label": "WRONG"}'
    client = _mock_client_returning(content)
    assert (
        lme_eval_module.lme_grader(client, question="q", golden_answer="g", response="other")
        is False
    )


def test_lme_grader_empty_body_raises_distinguishable_error(lme_eval_module):
    """Empty completions used to collapse into the same JSONDecodeError as a
    prose+JSON reply; now they raise ValueError with a readable preview."""
    client = _mock_client_returning("")
    with pytest.raises(ValueError) as excinfo:
        lme_eval_module.lme_grader(client, question="q", golden_answer="g", response="g")
    # The preview marker makes empty vs prose-without-label distinguishable.
    assert "preview" in str(excinfo.value).lower() or "''" in str(excinfo.value)
