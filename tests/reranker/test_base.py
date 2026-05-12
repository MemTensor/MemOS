from memos.reranker.base import BaseReranker
from memos.reranker.strategies.base import BaseRerankerStrategy
from tests.utils import check_module_base_class


def test_base_reranker_class_contract():
    check_module_base_class(BaseReranker)


def test_base_reranker_strategy_class_contract():
    check_module_base_class(BaseRerankerStrategy)
