from collections import Counter
from hashlib import sha256
from html import escape

import pytest

from evaluation.frontiermemory_topic.dataset import TRACE_SELECTIONS, build_pilot, parse_trace


def _html_message(role: str, ordinal: int, content: str) -> str:
    return (
        f'<article class="trace-step role-{role}">'
        f'<div class="trace-role"><span class="index">{ordinal:02}</span></div>'
        '<div class="trace-step-body">'
        f"<section><pre>{escape(content)}</pre></section>"
        '<section class="trace-tool result"><pre>raw tool output</pre></section>'
        "</div></article>"
    )


def _trace_html(*messages: tuple[str, int, str]) -> bytes:
    full = "".join(_html_message(*message) for message in messages)
    compact = _html_message("assistant", 99, "duplicate view")
    return (
        f'<div class="trace-full-view" hidden>{full}</div>'
        f'<div class="trace-compact-view">{compact}</div>'
    ).encode()


def _fake_pages() -> dict[str, bytes]:
    pages = {}
    for source in TRACE_SELECTIONS:
        messages = []
        for ordinal, _ in source.turns:
            messages.extend(
                [
                    ("user", ordinal, f"Request from {source.url} at {ordinal}"),
                    ("assistant", ordinal + 1, f"Reply at {ordinal + 1}"),
                ]
            )
        pages[source.url] = _trace_html(*messages)
    return pages


def test_full_trace_keeps_message_order_and_filters_non_dialogue():
    original = "Return the same document.\nKeep a <tag> & space."
    trace = _trace_html(
        ("user", 1, "You're working in the repository at /app."),
        ("assistant", 2, "A response to setup"),
        ("user", 5, original),
        ("assistant", 6, "First real reply"),
        ("assistant", 7, "Executed exec call_abcd"),
        ("assistant", 8, "Second real reply"),
        ("user", 10, "# Verifier result\nPASS"),
        ("assistant", 11, "A response to verifier"),
    )

    parsed = parse_trace(trace)

    assert list(parsed) == [5]
    assert [(row.ordinal, row.role, row.content) for row in parsed[5]] == [
        (5, "user", original),
        (6, "assistant", "First real reply"),
        (8, "assistant", "Second real reply"),
    ]


def test_pilot_contains_the_frozen_cross_user_sample():
    pages = _fake_pages()
    pilot = build_pilot(pages)
    turns = pilot["turns"]

    assert len(turns) == 16
    assert Counter(turn["wave"] for turn in turns) == {1: 6, 2: 6, 3: 4}
    assert Counter(turn["source_task"] for turn in turns) == {
        "tomlkit": 6,
        "returns": 4,
        "vitest": 6,
    }
    assert Counter(turn["gold_work"] for turn in turns) == {
        "tomlkit-conversion-api": 4,
        "tomlkit-release": 2,
        "returns-validated": 4,
        "vitest-sharding": 4,
        "vitest-file-sorting": 2,
    }
    assert len({turn["user_id"] for turn in turns}) == 6
    assert len({turn["conversation_id"] for turn in turns}) == 6
    assert len({turn["turn_id"] for turn in turns}) == 16
    assert all(turn["turn_id"] == turn["messages"][0]["message_id"] for turn in turns)
    for trace in TRACE_SELECTIONS:
        ordinals = [turn["source_ordinal"] for turn in turns if turn["trace_url"] == trace.url]
        assert ordinals == sorted(ordinals)
    assert turns[0]["trace_sha256"] == sha256(pages[turns[0]["trace_url"]]).hexdigest()
    assert len(turns[0]["content_sha256"]) == 64
    assert pilot == build_pilot(pages)


def test_pilot_rejects_selected_turn_when_the_source_drifted():
    pages = _fake_pages()
    source = TRACE_SELECTIONS[0]
    missing, _ = source.turns[0]
    pages[source.url] = _trace_html(("user", 9, "A different request"))

    with pytest.raises(ValueError, match=rf"{source.url}.*{missing}"):
        build_pilot(pages)


def test_pilot_rejects_duplicate_dialogue_in_different_html():
    pages = _fake_pages()
    first, second, *_ = TRACE_SELECTIONS
    pages[second.url] = pages[first.url] + b"<!-- different rendering wrapper -->"

    with pytest.raises(ValueError, match="duplicate dialogue"):
        build_pilot(pages)
