from memos.mem_feedback.base import BaseMemFeedback
from tests.utils import check_module_base_class


def test_base_mem_feedback_class_contract():
    check_module_base_class(BaseMemFeedback)
