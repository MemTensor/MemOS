"""Quick demo — run directly to see identity/relation detection in action.

Usage:
    PYTHONPATH="src:extensions" python extensions/memos_prompt_strategy_plugin/example.py
"""

from memos_prompt_strategy_plugin.classifier import MessageClassifier
from memos_prompt_strategy_plugin.strategies import build_identity_relation_prompt


def _src(role: str, content: str):
    class _S:
        pass

    s = _S()
    s.role = role
    s.content = content
    return s


DEMO_CONVERSATIONS = [
    {
        "label": "自我介绍 + 亲属关系",
        "sources": [_src("user", "你好，我叫王沐辰，我的儿子叫王明泽")],
        "mem_str": "你好，我叫王沐辰，我的儿子叫王明泽",
    },
    {
        "label": "仅自我介绍",
        "sources": [_src("user", "我是李明，今年30岁")],
        "mem_str": "我是李明，今年30岁",
    },
    {
        "label": "英文自我介绍 + 关系",
        "sources": [_src("user", "Hi, my name is Alice. My son is called Bob.")],
        "mem_str": "Hi, my name is Alice. My son is called Bob.",
    },
    {
        "label": "多种关系",
        "sources": [_src("user", "我叫张三，我老婆叫李四，我女儿叫张小花，我妈妈叫王秀英")],
        "mem_str": "我叫张三，我老婆叫李四，我女儿叫张小花，我妈妈叫王秀英",
    },
    {
        "label": "普通闲聊（不应命中）",
        "sources": [_src("user", "今天天气不错，出去走走吧")],
        "mem_str": "今天天气不错，出去走走吧",
    },
    {
        "label": "任务型（不应命中）",
        "sources": [_src("user", "请帮我安排明天下午3点的会议")],
        "mem_str": "请帮我安排明天下午3点的会议",
    },
]

SEPARATOR = "=" * 72


def main():
    clf = MessageClassifier()

    print(SEPARATOR)
    print("  Prompt Strategy Plugin — Identity/Relation Detection Demo")
    print(SEPARATOR)

    for data in DEMO_CONVERSATIONS:
        label = data["label"]
        sources = data["sources"]
        mem_str = data["mem_str"]

        category = clf.classify(sources, mem_str, "chat", {})
        hit = category is not None

        print(f"\n{'—' * 72}")
        print(f"  Scenario: {label}")
        print(f"  Input   : {mem_str[:80]}{'...' if len(mem_str) > 80 else ''}")
        print(f"  Hit     : {'YES → identity_relation' if hit else 'NO → use default prompt'}")

        if hit:
            lang = "zh" if any("\u4e00" <= c <= "\u9fff" for c in mem_str) else "en"
            prompt = build_identity_relation_prompt(lang=lang, mem_str=mem_str)
            print(f"  Prompt  : {prompt[:120]}...")

        print(f"{'—' * 72}")

    print(f"\n{SEPARATOR}")
    print("  Done.")
    print(SEPARATOR)


if __name__ == "__main__":
    main()
