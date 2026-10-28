import json

from memos.mem_reader.read_pref_memory.process_preference_memory import process_preference_fine
from memos.mem_reader.source_filter import MemorySourceFilter
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


class DummyLLM:
    def __init__(self):
        self.prompts = []

    def generate(self, messages):
        prompt = messages[0]["content"]
        self.prompts.append(prompt)
        if "显式偏好" in prompt:
            return json.dumps(
                [
                    {
                        "explicit_preference": "用户偏好简洁回答",
                        "context_summary": "用户要求后续回答简洁。",
                        "reasoning": "用户明确提出简洁要求。",
                        "topic": "answer_style",
                    }
                ],
                ensure_ascii=False,
            )
        return "[]"


class DummyEmbedder:
    def embed(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]


def make_fast_item(sources):
    return TextualMemoryItem(
        memory="\n".join(source.content or "" for source in sources),
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="user-1",
            session_id="session-1",
            memory_type="LongTermMemory",
            sources=sources,
        ),
    )


def test_preference_source_filter_drops_assistant_sources():
    source_filter = MemorySourceFilter()
    sources = [
        SourceMessage(type="chat", role="assistant", content="用户喜欢复杂长文。"),
        SourceMessage(type="chat", role="user", content="以后回答简洁一点。"),
    ]

    filtered = source_filter.filter_for_preference(sources)

    assert [source.content for source in filtered] == ["以后回答简洁一点。"]


def test_preference_source_filter_extracts_user_message_from_xiaoyi_context():
    source_filter = MemorySourceFilter()
    source = SourceMessage(
        type="chat",
        role="user",
        content=(
            "# 以下内容是基于用户发送的消息的搜索结果：# 搜索结果正文 "
            "# 以下是可能和用户问题关联的对话记忆 "
            "偏好：用户喜欢长文 "
            "# 小依大模型的思考过程：模型计划写一篇文章 "
            "# 用户消息为：请从资深教育工作者角度分析这个故事。"
        ),
    )

    filtered = source_filter.filter_for_preference([source])

    assert len(filtered) == 1
    assert filtered[0].content == "请从资深教育工作者角度分析这个故事。"


def test_preference_source_filter_keeps_plain_content_with_generic_phrases():
    source_filter = MemorySourceFilter()
    contents = [
        "请总结联网搜索到的资料，并保留搜索素材标题。",
        "我正在研究大模型的思考过程和 HEARTBEAT.md。",
        "在回答时，请注意以下几点：以后都用中文。",
        "当前时间: 2026-08-24，以后提醒时使用北京时间。",
        "Exec failed 是什么意思？",
        "“可能和用户问题关联的对话记忆”这个字段是什么意思？",
        "对话记忆分为事实和偏好，这种设计合理吗？",
    ]
    sources = [SourceMessage(type="chat", role="user", content=content) for content in contents]

    filtered = source_filter.filter_for_preference(sources)

    assert [source.content for source in filtered] == contents


def test_preference_source_filter_drops_context_without_user_boundary():
    source_filter = MemorySourceFilter()
    source = SourceMessage(
        type="chat",
        role="user",
        content="# 以下内容是基于用户发送的消息的搜索结果：# 搜索结果正文",
    )

    assert source_filter.filter_for_preference([source]) == []


def test_preference_source_filter_drops_cron_sources():
    source_filter = MemorySourceFilter()
    source = SourceMessage(
        type="chat",
        role="user",
        content="[cron:abc] 每天早上提醒用户吃早餐。",
    )

    assert source_filter.filter_for_preference([source]) == []


def test_preference_source_filter_coerces_numeric_message_id():
    source_filter = MemorySourceFilter()
    source = {
        "type": "chat",
        "role": "user",
        "message_id": 123,
        "content": "以后回答简洁一点。",
    }

    filtered = source_filter.filter_for_preference([source])

    assert len(filtered) == 1
    assert filtered[0].message_id == "123"


def test_process_preference_fine_uses_filtered_sources(monkeypatch):
    monkeypatch.setenv("ENABLE_PREFERENCE_MEMORY", "true")
    llm = DummyLLM()
    embedder = DummyEmbedder()
    sources = [
        SourceMessage(type="chat", role="assistant", content="用户喜欢复杂长文。"),
        SourceMessage(type="chat", role="user", content="以后回答简洁一点。"),
    ]
    fast_item = make_fast_item(sources)

    memories = process_preference_fine(
        [fast_item],
        {"user_id": "user-1", "session_id": "session-1"},
        llm,
        embedder,
    )

    assert len(memories) == 1
    assert memories[0].metadata.preference == "用户偏好简洁回答"
    assert [source.content for source in memories[0].metadata.sources] == ["以后回答简洁一点。"]
    assert any("以后回答简洁一点。" in prompt for prompt in llm.prompts)
    assert all("用户喜欢复杂长文" not in prompt for prompt in llm.prompts)
