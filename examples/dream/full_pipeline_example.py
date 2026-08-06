"""
Dream pipeline example — from a day's conversations to a dream.

Initializes the full MemOS stack, adds multi-session conversations
as memories, then runs the Dream pipeline with real LLM and graph_db:
  motive formation → recall → reasoning → diary → persistence

Usage:
    python examples/dream/full_pipeline_example.py
"""

from __future__ import annotations

import json

from memos.api import handlers
from memos.api.handlers.add_handler import AddHandler
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.product_models import APIADDRequest
from memos.plugins.manager import plugin_manager


def _print_json(title: str, value) -> None:
    print(f"\n{'=' * 80}\n  {title}\n{'=' * 80}")

    def _convert(v):
        if hasattr(v, "model_dump"):
            return v.model_dump(mode="json")
        if isinstance(v, list):
            return [_convert(i) for i in v]
        if isinstance(v, dict):
            return {k: _convert(i) for k, i in v.items()}
        return v

    print(json.dumps(_convert(value), indent=2, ensure_ascii=False, default=str))


# ---------------------------------------------------------------------------
# A day's conversations — the raw material for dreaming
# ---------------------------------------------------------------------------

CONVERSATIONS = [
    {
        "session_id": "weekly_report_start",
        "messages": [
            {
                "role": "user",
                "content": "下周要开周会，帮我总结一下这周 Dream 和记忆系统相关的进展。",
            },
            {
                "role": "assistant",
                "content": (
                    "这周完成了检索实验、filter 接口调整、Dream pipeline 初版、"
                    "用户访谈和一些评估准备。下周可以继续优化召回质量、完善指标，"
                    "并推进产品化验证。"
                ),
            },
        ],
    },
    {
        "session_id": "weekly_report_retry",
        "messages": [
            {"role": "user", "content": "太像流水账了。我想讲得更有方向感，不只是列出做了什么。"},
            {
                "role": "assistant",
                "content": (
                    "可以改成 OKR：目标是提升长期记忆系统质量，关键结果包括"
                    "召回效果提升、接口稳定、Dream 流程跑通、完成初步用户验证。"
                ),
            },
        ],
    },
    {
        "session_id": "future_planning_start",
        "messages": [
            {
                "role": "user",
                "content": (
                    "还是不对。下午我们换个问题：这个 AI 记忆系统未来到底应该往哪走？"
                    "是做更强的搜索，还是做能主动理解人的智能体？"
                ),
            },
            {
                "role": "assistant",
                "content": "短期建议提升搜索和召回，中期增加个性化画像，长期发展为主动式智能助理。",
            },
        ],
    },
    {
        "session_id": "future_planning_retry",
        "messages": [
            {"role": "user", "content": "这太泛了，谁都可以这么说。没有解释为什么非做这个不可。"},
            {
                "role": "assistant",
                "content": "可以表述为：我们要从被动检索走向主动记忆，让系统能在合适时间提醒用户重要信息。",
            },
        ],
    },
    {
        "session_id": "filter_design",
        "messages": [
            {
                "role": "user",
                "content": (
                    "晚上再讨论一个具体方案：现在项目里召回出来很多记忆，"
                    "但真正有用的很少。我想做一个新的 filter 模块，你觉得怎么设计？"
                ),
            },
            {
                "role": "assistant",
                "content": (
                    "可以设计 relevance、importance、recency 三个分数，"
                    "再接一个 reranker。接口上支持 metadata constraints，"
                    "并加入用户反馈闭环。"
                ),
            },
            {
                "role": "user",
                "content": "这些都像零件。方案本身没有灵魂，我不知道怎么说服别人它重要。",
            },
        ],
    },
]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

USER_ID = "dream_demo_user_0002"
CUBE_ID = "dream_demo_cube_0002"


def main() -> None:
    # 1. Initialize all components (LLM, graph_db, scheduler, dream plugin, ...)
    print("Initializing server components...")
    components = handlers.init_server()
    dependencies = HandlerDependencies.from_init_server(components)
    add_handler = AddHandler(dependencies)

    # 2. Add conversations as memories — hooks automatically accumulate Dream signals
    _print_json("Step 1: Adding memories", {"conversations": len(CONVERSATIONS)})
    for i, conv in enumerate(CONVERSATIONS, 1):
        req = APIADDRequest.model_validate(
            {
                "user_id": USER_ID,
                "writable_cube_ids": [CUBE_ID],
                "session_id": conv["session_id"],
                "messages": conv["messages"],
                "async_mode": "async",
            }
        )
        res = add_handler.handle_add_memories(req)
        print(f"  add #{i} (session={conv['session_id']}): {res.message}, data={len(res.data)}")

    # 3. Get the dream plugin and inspect signal state
    dream_plugin = plugin_manager.plugins.get("dream")
    if dream_plugin is None:
        print("Dream plugin not loaded — exiting.")
        return

    snapshot = dream_plugin.signal_store.snapshot(
        mem_cube_id=CUBE_ID,
        user_id=USER_ID,
        user_name="DreamDemoUser",
    )
    _print_json("Step 2: Dream signal snapshot", snapshot)
    print(f"  should_trigger: {dream_plugin.signal_store.should_trigger(mem_cube_id=CUBE_ID)}")

    # 4. Run the Dream pipeline directly (bypass scheduler, use real LLM + graph_db)
    _print_json("Step 3: Running Dream pipeline", {"cube": CUBE_ID})
    results = dream_plugin.pipeline.run(
        mem_cube_id=CUBE_ID,
        user_id=USER_ID,
        cube_id=CUBE_ID,
        signal_snapshot=snapshot,
        text_mem=None,
    )
    _print_json("Pipeline results", results)

    # 5. Reset signals after Dream completes
    dream_plugin.signal_store.reset(mem_cube_id=CUBE_ID)
    print("\nSignal store reset. Done.")


if __name__ == "__main__":
    main()
