"""
Suggestion handler for generating suggestion queries.

This module handles suggestion query generation based on user's recent memories
or further suggestions from chat history.
"""

import json

from typing import Any

from memos.api.product_models import SuggestionResponse
from memos.log import get_logger
from memos.mem_os.utils.format_utils import clean_json_response
from memos.templates.mos_prompts import (
    FURTHER_SUGGESTION_PROMPT,
    SUGGESTION_QUERY_PROMPT_EN,
    SUGGESTION_QUERY_PROMPT_ZH,
)
from memos.types import MessageList


logger = get_logger(__name__)


def _get_further_suggestion(
    llm: Any,
    message: MessageList,
) -> list[str]:
    """
    Get further suggestion based on recent dialogue.

    Args:
        llm: LLM instance for generating suggestions
        message: Recent chat messages

    Returns:
        List of suggestion queries
    """
    try:
        dialogue_info = "\n".join([f"{msg['role']}: {msg['content']}" for msg in message[-2:]])
        further_suggestion_prompt = FURTHER_SUGGESTION_PROMPT.format(dialogue=dialogue_info)
        message_list = [{"role": "system", "content": further_suggestion_prompt}]
        response = llm.generate(message_list)
        clean_response = clean_json_response(response)
        response_json = json.loads(clean_response)
        return response_json["query"]
    except Exception as e:
        logger.error(f"Error getting further suggestion: {e}", exc_info=True)
        return []


def handle_get_suggestion_queries(
    user_id: str,
    language: str,
    message: MessageList | None,
    llm: Any,
    naive_mem_cube: Any,
) -> SuggestionResponse:
    """
    Main handler for suggestion queries endpoint.

    Generates suggestion queries based on user's recent memories or chat history.

    Args:
        user_id: User ID
        language: Language preference ("zh" or "en")
        message: Optional chat message list for further suggestions
        llm: LLM instance
        naive_mem_cube: Memory cube instance

    Returns:
        SuggestionResponse with generated queries
    """
    try:
        # If message is provided, get further suggestions based on dialogue
        if message:
            suggestions = _get_further_suggestion(llm, message)
            return SuggestionResponse(
                message="Suggestions retrieved successfully",
                data={"query": suggestions},
            )

        # Otherwise, generate suggestions based on recent memories
        if language == "zh":
            suggestion_prompt = SUGGESTION_QUERY_PROMPT_ZH
        else:  # English
            suggestion_prompt = SUGGESTION_QUERY_PROMPT_EN

        # Search for recent memories
        text_mem_results = naive_mem_cube.text_mem.search(
            query="my recently memories",
            user_name=user_id,
            top_k=3,
            mode="fast",
            info={"user_id": user_id},
        )

        # Extract memory content
        memories = ""
        if text_mem_results:
            memories = "\n".join([m.memory[:200] for m in text_mem_results])

        # Generate suggestions using LLM
        message_list = [{"role": "system", "content": suggestion_prompt.format(memories=memories)}]
        response = llm.generate(message_list)
        clean_response = clean_json_response(response)
        response_json = json.loads(clean_response)

        return SuggestionResponse(
            message="Suggestions retrieved successfully",
            data={"query": response_json["query"]},
        )

    except Exception as e:
        logger.error(f"Failed to get suggestions: {e}", exc_info=True)
        raise
