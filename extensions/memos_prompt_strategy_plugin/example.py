"""Quick demo — run directly to see classification + prompt strategy in action.

Usage:
    PYTHONPATH="src:extensions" python extensions/memos_prompt_strategy_plugin/example.py
"""

from memos_prompt_strategy_plugin.classifier import MessageClassifier
from memos_prompt_strategy_plugin.strategies import StrategyRegistry


def _src(role: str, content: str):
    class _S:
        pass

    s = _S()
    s.role = role
    s.content = content
    return s


DEMO_CONVERSATIONS = {
    "casual_chat": {
        "sources": [_src("user", "Hey! I really like Italian food, especially pasta.")],
        "mem_str": "Hey! I really like Italian food, especially pasta.",
    },
    "task_oriented": {
        "sources": [
            _src("user", "请帮我安排明天下午3点的会议，提醒我截止日期是周五"),
            _src("assistant", "好的，已经帮你安排好了"),
        ],
        "mem_str": "请帮我安排明天下午3点的会议，提醒我截止日期是周五\n好的，已经帮你安排好了",
    },
    "code_discussion": {
        "sources": [
            _src(
                "user",
                "I'm getting an error with my FastAPI app:\n"
                "```python\n"
                "from fastapi import APIRouter\n"
                "router = APIRouter()\n"
                "@router.get('/health')\n"
                "async def health(): return {'ok': True}\n"
                "```\n"
                "The import fails after upgrading the SDK.",
            ),
        ],
        "mem_str": (
            "I'm getting an error with my FastAPI app:\n"
            "```python\nfrom fastapi import APIRouter\n```\n"
            "The import fails after upgrading the SDK."
        ),
    },
    "emotional": {
        "sources": [
            _src("user", "今天特别开心，终于完成了马拉松，虽然很累但是非常骄傲"),
        ],
        "mem_str": "今天特别开心，终于完成了马拉松，虽然很累但是非常骄傲",
    },
    "multi_turn_qa": {
        "sources": [
            _src("user", "What's the difference between Redis and Memcached?"),
            _src("assistant", "Redis supports more data structures. What's your use case?"),
            _src("user", "I need pub/sub and sorted sets. Which one fits?"),
            _src("assistant", "Redis is the clear choice for pub/sub and sorted sets."),
        ],
        "mem_str": (
            "What's the difference between Redis and Memcached?\n"
            "Redis supports more data structures. What's your use case?\n"
            "I need pub/sub and sorted sets. Which one fits?\n"
            "Redis is the clear choice for pub/sub and sorted sets."
        ),
    },
    "knowledge_sharing": {
        "sources": [
            _src(
                "user",
                "\n".join(
                    [
                        "Transformers are a neural network architecture introduced in 2017.",
                        "They use self-attention mechanisms to process sequences in parallel.",
                        "Unlike RNNs, transformers don't require sequential computation.",
                        "The key components are: multi-head attention, feed-forward networks,",
                        "layer normalization, and positional encoding.",
                        "Pre-training on large corpora followed by fine-tuning has become",
                        "the dominant paradigm in NLP since BERT (2018).",
                    ]
                    * 3
                ),
            ),
        ],
        "mem_str": "Transformers are a neural network architecture..." + "x" * 800,
    },
}

SEPARATOR = "=" * 72


def main():
    clf = MessageClassifier()
    reg = StrategyRegistry()
    reg.register_defaults()

    print(SEPARATOR)
    print("  Prompt Strategy Plugin — Classification Demo")
    print(SEPARATOR)

    for label, data in DEMO_CONVERSATIONS.items():
        sources = data["sources"]
        mem_str = data["mem_str"]

        category = clf.classify(sources, mem_str, "chat", {})
        prompt = reg.build_prompt(
            category, "zh" if any("\u4e00" <= c <= "\u9fff" for c in mem_str) else "en", mem_str
        )

        status = "MATCH" if category == label else "MISMATCH"
        print(f"\n{'—' * 72}")
        print(f"  Scenario : {label}")
        print(f"  Classified: {category}  [{status}]")
        print(f"  Input     : {mem_str[:80]}{'...' if len(mem_str) > 80 else ''}")
        print(
            f"  Prompt    : {prompt[:120]}..." if prompt else "  Prompt    : (default, no override)"
        )
        print(f"{'—' * 72}")

    print(f"\n{SEPARATOR}")
    print("  All scenarios processed.")
    print(SEPARATOR)


if __name__ == "__main__":
    main()
