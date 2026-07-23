from __future__ import annotations

from memos.dream.contextualization import DreamContextReport
from memos.dream.pipeline.diary import StructuredDiarySummary


def test_diary_summary_creates_context_only_entry_from_context_report():
    report = DreamContextReport(
        processed_memory_count=2,
        created_context_count=1,
        updated_context_count=0,
        bound_memory_count=2,
        skipped_memory_count=0,
        contexts=[
            {
                "context_id": "ctx_1",
                "action": "created",
                "label": "first-week-closed-loop",
                "summary": "第一周闭环包含 Context binding 和 Search A。",
                "source_memory_ids": ["m1", "m2"],
                "binding_strategy": "llm",
                "summary_strategy": "llm",
            }
        ],
    )

    results = StructuredDiarySummary().generate(
        clusters=[],
        results=[],
        mem_cube_id="cube-a",
        context_report=report,
    )

    assert len(results) == 1
    entry = results[0].diary_entry
    assert entry is not None
    assert entry.status == "context_only"
    assert entry.title == "Dream Context Summary"
    assert entry.context_events == report.contexts
    assert "first-week-closed-loop" in entry.summary
    assert "第一周闭环" in entry.dream_entry
