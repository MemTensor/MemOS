from evaluation.frontiermemory_topic.label_llm import conflicts_prompt, parse_json, propose_prompt


def _turn(turn_id, ordinal, gold, source, user="u1"):
    return {
        "turn_id": turn_id,
        "trace_url": f"https://frontiermemory.com/traces/t/{user}/",
        "user_id": user,
        "source_ordinal": ordinal,
        "gold_work": gold,
        "label_source": source,
        "messages": [
            {"role": "user", "content": f"ask {turn_id}"},
            {"role": "assistant", "content": "reply"},
        ],
    }


def test_proposal_prompt_hides_reviewed_labels_but_shows_frozen_anchors():
    turns = [_turn("a", 1, "t-frozen", "codex-frozen"), _turn("b", 2, "t-secret", "manual-review")]
    prompt = propose_prompt("t", turns, {"t-frozen": {"why": "anchor"}})
    assert "t-frozen: anchor" in prompt and "FROZEN gold_work=t-frozen" in prompt
    assert "t-secret" not in prompt and "[b] LABEL ME" in prompt


def test_conflict_prompt_lists_only_multi_turn_groups_and_reply_parses():
    turns = [_turn("a", 1, "g", "x"), _turn("b", 2, "g", "x", "u2"), _turn("c", 3, "solo", "x")]
    prompt = conflicts_prompt("t", turns)
    assert "gold_work g" in prompt and "user=u2" in prompt and "solo" not in prompt
    assert parse_json('```json\n{"conflicts": []}\n```') == {"conflicts": []}
