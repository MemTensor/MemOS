"""Preference memory extractor."""

import json
import os
import uuid

from concurrent.futures import as_completed
from datetime import datetime
from typing import TYPE_CHECKING, Any

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_reader.read_multi_modal import detect_lang
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.templates.prefer_complete_prompt import (
    NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
    NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT,
    NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
)


if TYPE_CHECKING:
    from memos.types.general_types import UserContext


logger = get_logger(__name__)


def _extract_explicit_preference(qa_pair_str: str, llm) -> list[dict[str, Any]] | None:
    """Extract explicit preference from a QA pair string."""
    lang = detect_lang(qa_pair_str)
    _map = {
        "zh": NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
        "en": NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT,
    }
    prompt = _map[lang].replace("{qa_pair}", qa_pair_str)

    try:
        response = llm.generate([{"role": "user", "content": prompt}])
        if not response:
            logger.info(
                f"[prefer_extractor]: (Error) LLM response content is {response} when extracting explicit preference"
            )
            return None
        response = response.strip().replace("```json", "").replace("```", "").strip()
        result = json.loads(response)
        for d in result:
            d["preference"] = d.pop("explicit_preference")
        return result
    except Exception as e:
        logger.info(f"Error extracting explicit preference: {e}, return None")
        return None


def _extract_implicit_preference(qa_pair_str: str, llm) -> list[dict[str, Any]] | None:
    """Extract implicit preferences from a QA pair string."""
    if not qa_pair_str:
        return None

    lang = detect_lang(qa_pair_str)
    _map = {
        "zh": NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT_ZH,
        "en": NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT,
    }
    prompt = _map[lang].replace("{qa_pair}", qa_pair_str)

    try:
        response = llm.generate([{"role": "user", "content": prompt}])
        if not response:
            logger.info(
                f"[prefer_extractor]: (Error) LLM response content is {response} when extracting implicit preference"
            )
            return None
        response = response.strip().replace("```json", "").replace("```", "").strip()
        result = json.loads(response)
        for d in result:
            d["preference"] = d.pop("implicit_preference")
        return result
    except Exception as e:
        logger.info(f"Error extracting implicit preferences: {e}, return None")
        return None


def _create_preference_memory_item(
    preference_data: dict[str, Any], preference_type: str, info: dict[str, Any], embedder, **kwargs
) -> TextualMemoryItem:
    """
    Create a preference memory item with proper metadata.

    Args:
        preference_data: Dictionary containing preference, context_summary, reasoning, topic
        preference_type: "explicit_preference" or "implicit_preference"
        info: Dictionary containing user_id, session_id, etc.
        embedder: Embedder instance
        kwargs: Additional parameters including user_context

    Returns:
        TextualMemoryItem with TreeNodeTextualMemoryMetadata
    """
    # Make a copy of info to avoid modifying the original
    info_ = info.copy()

    # Extract fields that should be at metadata level
    user_id = info_.pop("user_id", "")
    session_id = info_.pop("session_id", "")

    # Extract manager_user_id, project_id, and operation from user_context
    user_context: UserContext | None = kwargs.get("user_context")
    manager_user_id = user_context.manager_user_id if user_context else None
    project_id = user_context.project_id if user_context else None

    # Generate embedding for context_summary
    context_summary = preference_data.get("context_summary", "")
    embedding = embedder.embed([context_summary])[0] if embedder and context_summary else None

    # Build basic info for this preference
    created_at = datetime.now().isoformat()

    # Create metadata
    metadata = TreeNodeTextualMemoryMetadata(
        memory_type="PreferenceMemory",
        embedding=embedding,
        user_id=user_id,
        session_id=session_id,
        status="activated",
        tags=[],
        type="chat",
        created_at=created_at,
        updated_at=created_at,
        info=info_,
        sources=[],
        usage=[],
        background="",
        # Preference-specific fields
        preference_type=preference_type,
        preference=preference_data.get("preference", ""),
        reasoning=preference_data.get("reasoning", ""),
        topic=preference_data.get("topic", ""),
        # User-specific fields
        manager_user_id=manager_user_id,
        project_id=project_id,
    )

    # Create and return memory item
    return TextualMemoryItem(id=str(uuid.uuid4()), memory=context_summary, metadata=metadata)


def _process_single_chunk_explicit(
    original_text: str, info: dict[str, Any], llm, embedder, **kwargs
) -> list[TextualMemoryItem]:
    """Process a single chunk for explicit preferences."""
    if not original_text.strip():
        return []

    explicit_pref = _extract_explicit_preference(original_text, llm)
    if not explicit_pref:
        return []

    memories = []
    for pref in explicit_pref:
        memory = _create_preference_memory_item(
            preference_data=pref,
            preference_type="explicit_preference",
            info=info,
            embedder=embedder,
            **kwargs,
        )
        memories.append(memory)

    return memories


def _process_single_chunk_implicit(
    original_text: str, info: dict[str, Any], llm, embedder, **kwargs
) -> list[TextualMemoryItem]:
    """Process a single chunk for implicit preferences."""
    if not original_text.strip():
        return []

    implicit_pref = _extract_implicit_preference(original_text, llm)
    if not implicit_pref:
        return []

    memories = []
    for pref in implicit_pref:
        memory = _create_preference_memory_item(
            preference_data=pref,
            preference_type="implicit_preference",
            info=info,
            embedder=embedder,
            **kwargs,
        )
        memories.append(memory)

    return memories


def process_preference_fine(
    fast_memory_items: list[TextualMemoryItem],
    info: dict[str, Any],
    llm=None,
    embedder=None,
    **kwargs,
) -> list[TextualMemoryItem]:
    """
    Extract preference memories from fast_memory_items (for fine mode processing).

    Args:
        fast_memory_items: List of TextualMemoryItem from fast parsing
        info: Dictionary containing user_id and session_id
        llm: LLM instance
        embedder: Embedder instance
        kwargs: Additional parameters (including user_context)

    Returns:
        List of preference memory items
    """

    if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
        return []

    if not fast_memory_items or not llm:
        return []

    try:
        # Convert fast_memory_items to messages format
        chunks = []
        for fast_item in fast_memory_items:
            mem_str = fast_item.memory or ""
            if not mem_str.strip():
                continue
            chunks.append(mem_str)

        if not chunks:
            return []

        # Process chunks in parallel
        memories = []
        with ContextThreadPoolExecutor(max_workers=min(10, len(chunks))) as executor:
            futures = {}

            # Submit explicit extraction tasks
            for chunk in chunks:
                future = executor.submit(
                    _process_single_chunk_explicit, chunk, info, llm, embedder, **kwargs
                )
                futures[future] = ("explicit_preference", chunk)

            # Submit implicit extraction tasks
            for chunk in chunks:
                future = executor.submit(
                    _process_single_chunk_implicit, chunk, info, llm, embedder, **kwargs
                )
                futures[future] = ("implicit_preference", chunk)

            # Collect results
            for future in as_completed(futures):
                try:
                    memory = future.result()
                    if memory:
                        if isinstance(memory, list):
                            memories.extend(memory)
                        else:
                            memories.append(memory)
                except Exception as e:
                    task_type, chunk = futures[future]
                    logger.warning(
                        f"[process_preference_fine] Error processing {task_type} chunk, original text: {chunk}: {e}"
                    )
                    continue

        if memories:
            logger.info(f"[process_preference_fine] Extracted {len(memories)} preference memories")

        return memories
    except Exception as e:
        logger.warning(
            f"[process_preference_fine] Failed to extract preferences: {e}", exc_info=True
        )
        return []
