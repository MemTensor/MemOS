import pytest

from memos.templates.prefer_complete_prompt import (
    NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
    NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
)


@pytest.mark.parametrize(
    ("prompt", "source_constraint", "scope_constraint"),
    [
        (
            NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT,
            "even if it is wrapped in a user message",
            "rather than how many times it appears in the conversation",
        ),
        (
            NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
            "即使这些内容被包装在 user 消息中",
            "而不是其在对话中出现的次数",
        ),
        (
            NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT,
            "even if it is wrapped in a user message",
            "Temporary requirements, execution parameters, and one-off needs",
        ),
        (
            NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
            "即使这些内容被包装在 user 消息中",
            "临时要求、执行参数和一次性需求",
        ),
    ],
)
def test_preference_prompts_include_source_and_scope_constraints(
    prompt: str,
    source_constraint: str,
    scope_constraint: str,
):
    assert source_constraint in prompt
    assert scope_constraint in prompt
