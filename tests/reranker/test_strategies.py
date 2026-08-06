from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.reranker.strategies.concat_background import ConcatBackgroundStrategy
from memos.reranker.strategies.concat_docsource import ConcatDocSourceStrategy
from memos.reranker.strategies.dialogue_common import DialogueRankingTracker, extract_content
from memos.reranker.strategies.single_turn import SingleTurnStrategy
from memos.reranker.strategies.singleturn_outmem import SingleTurnOutMemStrategy


def _memory_item(
    item_id: str = "00000000-0000-0000-0000-000000000001",
    memory: str = "[tag] remembers preferred answer style",
    sources: list[dict] | None = None,
    background: str = "background note",
):
    return TextualMemoryItem(
        id=item_id,
        memory=memory,
        metadata=TreeNodeTextualMemoryMetadata(
            background=background,
            embedding=[1.0, 0.0],
            sources=sources or [],
        ),
    )


def test_extract_content_supports_dict_source_message_and_string():
    source = SourceMessage(role="user", content="from model", chat_time="2026-05-12")

    assert extract_content({"content": "from dict"}) == "from dict"
    assert extract_content(source) == "from model"
    assert extract_content("raw text") == "raw text"


def test_dialogue_ranking_tracker_builds_documents_and_bounds_lookup():
    tracker = DialogueRankingTracker()
    pair_id = tracker.add_dialogue_pair(
        "memory-1",
        0,
        {"content": "hello"},
        {"content": "hi"},
        "memory body",
        chat_time="2026-05-12",
    )

    assert pair_id == "memory-1_0"
    assert tracker.get_dialogue_pair_by_index(0).user_content == "hello"
    assert tracker.get_dialogue_pair_by_index(99) is None
    assert tracker.get_documents_for_ranking() == [
        "memory body\n\n[2026-05-12]: \nuser: hello\nassistant: hi"
    ]


def test_single_turn_strategy_prepares_documents_from_chat_pairs():
    item = _memory_item(
        sources=[
            {"role": "user", "content": "What should I do?", "chat_time": "2026-05-12"},
            {"role": "assistant", "content": "Use the concise answer style."},
        ]
    )

    tracker, original_items, documents = SingleTurnStrategy().prepare_documents(
        "answer style",
        [item],
        top_k=1,
    )

    assert original_items == {item.id: item}
    assert len(tracker.dialogue_pairs) == 1
    assert documents == [
        "remembers preferred answer style\n\n"
        "[2026-05-12]: \nuser: What should I do?\nassistant: Use the concise answer style."
    ]


def test_single_turn_strategy_reconstructs_ranked_dialogue_items():
    item = _memory_item(
        sources=[
            {"role": "user", "content": "question"},
            {"role": "assistant", "content": "answer"},
        ]
    )
    strategy = SingleTurnStrategy()
    tracker, original_items, _documents = strategy.prepare_documents("query", [item], top_k=1)

    ranked = strategy.reconstruct_items([0], [0.9], tracker, original_items, top_k=1)

    assert ranked[0][1] == 0.9
    assert "sources-dialogue-pairs" in ranked[0][0].memory
    assert ranked[0][0] is not item


def test_single_turn_outmem_strategy_aggregates_by_original_memory():
    item = _memory_item(
        sources=[
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "second"},
            {"role": "assistant", "content": "answer"},
        ]
    )
    strategy = SingleTurnOutMemStrategy()
    tracker, original_items, _documents = strategy.prepare_documents("query", [item], top_k=1)

    ranked = strategy.reconstruct_items([0, 1], [0.2, 0.8], tracker, original_items, top_k=1)

    assert ranked == [(item, 0.8)]


def test_concat_background_strategy_includes_background_text():
    item = _memory_item()

    _tracker, _original_items, documents = ConcatBackgroundStrategy().prepare_documents(
        "answer style",
        [item],
        top_k=1,
    )

    assert documents == ["remembers preferred answer style\nbackground note"]


def test_concat_docsource_strategy_includes_file_source_content():
    item = _memory_item(
        sources=[
            {
                "type": "file",
                "content": "file chunk",
            }
        ]
    )

    _tracker, _original_items, documents = ConcatDocSourceStrategy().prepare_documents(
        "answer style",
        [item],
        top_k=1,
    )

    assert documents == ["remembers preferred answer style\n\n[Sources]:\nfile chunk"]
