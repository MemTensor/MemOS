import pytest

from memos.configs.reranker import RerankerConfigFactory
from memos.reranker.cosine_local import CosineLocalReranker
from memos.reranker.factory import RerankerFactory
from memos.reranker.noop import NoopReranker
from memos.reranker.strategies.concat_background import ConcatBackgroundStrategy
from memos.reranker.strategies.concat_docsource import ConcatDocSourceStrategy
from memos.reranker.strategies.factory import RerankerStrategyFactory
from memos.reranker.strategies.single_turn import SingleTurnStrategy
from memos.reranker.strategies.singleturn_outmem import SingleTurnOutMemStrategy


def test_reranker_factory_returns_none_for_missing_config():
    assert RerankerFactory.from_config(None) is None


def test_reranker_factory_builds_noop_reranker():
    config = RerankerConfigFactory(backend="noop")

    assert isinstance(RerankerFactory.from_config(config), NoopReranker)


def test_reranker_factory_builds_cosine_local_reranker_with_options():
    config = RerankerConfigFactory(
        backend="cosine_local",
        config={
            "level_weights": {"topic": 2.0},
            "level_field": "background",
        },
    )

    reranker = RerankerFactory.from_config(config)

    assert isinstance(reranker, CosineLocalReranker)
    assert reranker.level_weights == {"topic": 2.0}
    assert reranker.level_field == "background"


def test_reranker_factory_rejects_unknown_backend():
    config = RerankerConfigFactory(backend="unknown")

    with pytest.raises(ValueError, match="Unknown reranker backend"):
        RerankerFactory.from_config(config)


@pytest.mark.parametrize(
    ("backend", "expected_class"),
    [
        ("single_turn", SingleTurnStrategy),
        ("concat_background", ConcatBackgroundStrategy),
        ("singleturn_outmem", SingleTurnOutMemStrategy),
        ("concat_docsource", ConcatDocSourceStrategy),
    ],
)
def test_reranker_strategy_factory_builds_supported_strategies(backend, expected_class):
    assert isinstance(RerankerStrategyFactory.from_config(backend), expected_class)


def test_reranker_strategy_factory_rejects_unknown_backend():
    with pytest.raises(ValueError, match="Invalid backend"):
        RerankerStrategyFactory.from_config("missing")
