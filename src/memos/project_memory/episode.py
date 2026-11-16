# -*- coding: utf-8 -*-
"""episode（段）切分：决策与经验共用（T1 §1、经验方案 §1.3）。

照谁：话题边界由抽取框架已有的那次调用顺带判（EverOS）；上限 64k token / 500 条（EverOS）；
空闲 10 分钟（MemoraX）；Agent 写了经验稿立即关段（腾讯）。
主干不连调度器，关段只在这里算，入队交给 scheduler_handler（TODO：挂 MEM_ORGANIZE 之外的新标签）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .types import Episode, Msg, new_id


MAX_TOKENS = 64_000
MAX_MESSAGES = 500
IDLE_MINUTES = 10
CHARS_PER_TOKEN = 4  # 粗估，接真模型时换 tokenizer


@dataclass
class SegmenterConfig:
    max_tokens: int = MAX_TOKENS
    max_messages: int = MAX_MESSAGES
    idle_minutes: int = IDLE_MINUTES
    chars_per_token: int = CHARS_PER_TOKEN


def _estimate_tokens(msgs: list[Msg]) -> int:
    total = 0
    for m in msgs:
        body = m.text or ""
        body += m.tool_args or ""
        body += m.tool_output or ""
        total += max(1, len(body) // CHARS_PER_TOKEN)
    return total


def _parse_time(s: str) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def split_episodes(
    messages: list[Msg],
    space_id: str,
    conversation_id: str,
    boundary_flags: list[bool] | None = None,
    note_after: set[str] | None = None,
    config: SegmenterConfig | None = None,
) -> list[Episode]:
    """把一次提交的消息切成若干段。

    `boundary_flags[i] = True` 表示第 i 条之前是新话题（抽取框架判出来的），主干先由调用方给；
    `note_after` 是写了经验稿的消息 id，其后立即关段。
    """
    cfg = config or SegmenterConfig()
    boundary_flags = boundary_flags or []
    note_after = note_after or set()

    episodes: list[Episode] = []
    cur: list[Msg] = []
    prev_tail: list[Msg] = []

    def close(reason: str) -> None:
        nonlocal cur, prev_tail
        if not cur:
            return
        episodes.append(
            Episode(
                id=new_id("ep"),
                space_id=space_id,
                conversation_id=conversation_id,
                messages=cur,
                prev=list(prev_tail),
                closed_reason=reason,
            )
        )
        prev_tail = cur[-2:] if len(cur) >= 2 else list(cur)
        cur = []

    for i, m in enumerate(messages):
        if cur:
            if i < len(boundary_flags) and boundary_flags[i]:
                close("topic_boundary")
            else:
                last_t = _parse_time(cur[-1].chat_time)
                this_t = _parse_time(m.chat_time)
                if last_t and this_t and (this_t - last_t).total_seconds() > cfg.idle_minutes * 60:
                    close("idle_timeout")
                elif _estimate_tokens(cur) >= cfg.max_tokens:
                    close("max_tokens")
                elif len(cur) >= cfg.max_messages:
                    close("max_messages")

        cur.append(m)

        if m.id in note_after:
            close("experience_note")

    close("end_of_input")
    return episodes
