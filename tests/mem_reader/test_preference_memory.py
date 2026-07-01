import json

from unittest.mock import MagicMock

from memos.mem_reader.read_pref_memory.process_preference_memory import (
    _process_single_chunk_explicit,
    _process_single_chunk_implicit,
)


def test_explicit_preference_processing_skips_empty_preference_items() -> None:
    llm = MagicMock()
    llm.generate.return_value = json.dumps(
        [
            {
                "explicit_preference": "   ",
                "context_summary": "Empty preference should not be stored.",
                "reasoning": "No usable preference.",
                "topic": "style",
            },
            {
                "explicit_preference": " Prefers concise answers. ",
                "context_summary": "The user asked for concise answers.",
                "reasoning": "The user explicitly requested concise answers.",
                "topic": "style",
            },
        ]
    )
    embedder = MagicMock()
    embedder.embed.return_value = [[0.1, 0.2]]

    memories = _process_single_chunk_explicit(
        "user: keep answers short",
        fast_item=None,
        info={"user_id": "u1", "session_id": "s1"},
        llm=llm,
        embedder=embedder,
    )

    assert len(memories) == 1
    assert memories[0].metadata.preference == "Prefers concise answers."


def test_implicit_preference_processing_skips_missing_preference_items() -> None:
    llm = MagicMock()
    llm.generate.return_value = json.dumps(
        [
            {
                "implicit_preference": "",
                "context_summary": "No implicit preference can be inferred.",
                "reasoning": "Insufficient evidence.",
                "topic": "movies",
            },
            {
                "implicit_preference": "Prefers science fiction movies.",
                "context_summary": "The user repeatedly chose science fiction movies.",
                "reasoning": "Repeated choices indicate a preference.",
                "topic": "movies",
            },
        ]
    )
    embedder = MagicMock()
    embedder.embed.return_value = [[0.1, 0.2]]

    memories = _process_single_chunk_implicit(
        "user: let's watch another space movie",
        fast_item=None,
        info={"user_id": "u1", "session_id": "s1"},
        llm=llm,
        embedder=embedder,
    )

    assert len(memories) == 1
    assert memories[0].metadata.preference == "Prefers science fiction movies."
