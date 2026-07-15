"""Sample data for MemReader examples.

This module contains test cases and sample data for various MemReader scenarios,
including simple chat, multimodal messages, file content, and tool usage.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class TestCase:
    """Base class for test cases."""

    name: str
    description: str
    scene_data: Any
    expected_count: dict[str, int] = field(default_factory=dict)

    def get_info(self) -> dict[str, Any]:
        """Get info dict for this test case."""
        return {
            "user_id": "test_user",
            "session_id": f"session_{self.name}",
            "test_case": self.name,
        }


# ============================================================================
# 1. Simple Chat Samples (for SimpleStructMemReader)
# ============================================================================

SIMPLE_CHAT_SCENE = [
    [
        {"role": "user", "chat_time": "3 May 2025", "content": "I'm feeling a bit down today."},
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "I'm sorry to hear that. Do you want to talk about what's been going on?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "It's just been a tough couple of days, you know? Everything feels a bit overwhelming, and I just can't seem to shake it off.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "It sounds like you're going through a lot right now. Sometimes it helps to talk things out. Is there something specific that's been weighing on you, or is it more of a general feeling?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "It's a mix, I guess. Work's been really stressful, and on top of that, I've been feeling kinda disconnected from the people around me.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "That can be really draining, especially when you're feeling isolated on top of the stress. Do you think there's something from your past that's contributing to how you're feeling now? Sometimes our emotions are tied to older experiences.",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "Yeah, now that you mention it… I've been thinking a lot about my childhood lately. I didn't have the easiest upbringing. My parents were always busy, and I often felt like I had to figure things out on my own. I remember one winter, I got really sick with a high fever. My parents were both working, and I didn't want to bother them. I just lay in bed, crying by myself, not knowing what to do.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "That must have been very lonely. Growing up without that support can really make you feel like you have to handle everything on your own. How do you think that experience has affected you now?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "Yeah, it was really lonely. I remember spending a lot of time doing things on my own, like drawing, because it was my only way to escape. I used to draw animals, and I created my own little world on paper. It was peaceful in a way, just me and my imagination, with no outside distractions.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "Drawing sounds like a beautiful way to express yourself and find some peace in that solitude. It must have been a very quiet and private world for you. Do you think that sense of loneliness from back then has shaped how you connect with others today?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "I think it has. I've always found it hard to let others in. I feel like I have to handle everything on my own. If I rely on someone else, I feel vulnerable, and I start to feel that loneliness again.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "It sounds like this was a protective mechanism that helped you cope with your feelings of loneliness back then. But as you've grown, it seems like this pattern might not be serving you as well anymore. Have you thought about trying to break this cycle, or finding new ways to connect with others?",
        },
    ]
]

# ============================================================================
# 2. String Message Cases
# ============================================================================

STRING_MESSAGE_CASES = [
    TestCase(
        name="string_simple",
        description="Simple string message",
        scene_data=[
            "This is a simple text message that needs to be parsed.",
            "Another string message for processing.",
            "StringParser handles plain text strings and converts them to SourceMessage objects.",
        ],
        expected_count={"fast": 1, "fine": 1},
    ),
    TestCase(
        name="string_multiple",
        description="Multiple string messages",
        scene_data=[
            "这是第一条消息。",
            "这是第二条消息。",
            "这是第三条消息。",
        ],
    ),
]

# ============================================================================
# 3. Chat Message Cases (Standard & Multimodal)
# ============================================================================

CHAT_MESSAGE_CASES = [
    TestCase(
        name="chat_simple",
        description="Simple chat conversation",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": "Hello, how are you? I'm planning to learn Python next week.",
                    "chat_time": "2025-01-01T10:00:00Z",
                    "message_id": "chat_simple_u1",
                },
                {
                    "role": "assistant",
                    "content": "I'm doing well, thank you!",
                    "chat_time": "2025-01-01T10:00:01Z",
                    "message_id": "chat_simple_a1",
                },
            ]
        ],
    ),
    TestCase(
        name="chat_with_system",
        description="Chat with system message",
        scene_data=[
            [
                {
                    "role": "system",
                    "content": "You are a helpful assistant.",
                    "chat_time": "2025-01-01T10:00:00Z",
                    "message_id": "chat_sys_s1",
                },
                {
                    "role": "user",
                    "content": "What's the weather?",
                    "chat_time": "2025-01-01T10:00:01Z",
                    "message_id": "chat_sys_u1",
                },
                {
                    "role": "assistant",
                    "content": "I don't have access to weather data.",
                    "chat_time": "2025-01-01T10:00:02Z",
                    "message_id": "chat_sys_a1",
                },
            ]
        ],
    ),
    TestCase(
        name="chat_multimodal_complex",
        description="Complex multimodal chat with text, file, and image",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "我是测试base64"},
                        {
                            "type": "file",
                            "file": {
                                "file_data": "Hello World",
                                "filename": "example.txt",
                                "file_id": "file_123",
                            },
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "https://statics.memtensor.com.cn/memos/memos-banner.gif",
                                "detail": "auto",
                            },
                        },
                    ],
                    "chat_time": "2025-01-01T10:00:03Z",
                    "message_id": "chat_mm_u1",
                }
            ]
        ],
    ),
]


# ============================================================================
# 4. Tool Message Cases
# ============================================================================

TOOL_MESSAGE_CASES = [
    TestCase(
        name="tool_weather",
        description="Weather tool result",
        scene_data=[
            {
                "role": "user",
                "content": "I'm planning a hiking trip to New York this weekend, can you check the weather?",
                "chat_time": "2025-01-15T10:00:00",
                "message_id": "msg_000",
            },
            {
                "role": "tool",
                "content": '{"result": "Weather in New York: 72°F, sunny"}',
                "tool_call_id": "call_abc123",
                "chat_time": "2025-01-15T10:00:30",
                "message_id": "msg_001",
            },
        ],
    ),
    TestCase(
        name="tool_data",
        description="Data API result",
        scene_data=[
            {
                "role": "user",
                "content": "Please retrieve my saved reading list items.",
                "chat_time": "2025-01-15T10:05:00",
                "message_id": "msg_000_2",
            },
            {
                "role": "tool",
                "content": '{"status": "success", "data": {"items": ["The Great Gatsby", "1984", "Python Crash Course"]}}',
                "tool_call_id": "call_def456",
                "chat_time": "2025-01-15T10:05:30",
                "message_id": "msg_002",
            },
        ],
    ),
    TestCase(
        name="tool_db",
        description="Database query result",
        scene_data=[
            {
                "role": "user",
                "content": "Did I complete the registration for the upcoming workshop?",
                "chat_time": "2025-01-15T10:10:00",
                "message_id": "msg_000_3",
            },
            {
                "role": "tool",
                "content": "Database query executed successfully. Found registration record for user_id=123: status=confirmed.",
                "tool_call_id": "call_ghi789",
                "chat_time": "2025-01-15T10:10:30",
                "message_id": "msg_003",
            },
        ],
    ),
]

# ============================================================================
# 5. File Content Samples (for FileContentParser Demo)
# ============================================================================

FILE_CONTENT_PARTS = [
    {
        "type": "file",
        "file": {
            "filename": "document.pdf",
            "file_id": "file_123",
            "file_data": "This is the content extracted from the PDF file...",
        },
    },
    {
        "type": "file",
        "file": {
            "filename": "report.docx",
            "file_id": "file_456",
            "file_data": "Report content: Analysis of Q4 performance...",
        },
    },
    {
        "type": "file",
        "file": {
            "filename": "data.csv",
            "file_id": "file_789",
            "path": "/path/to/data.csv",
        },
    },
]

FILE_CONTENT_REAL_FILE_PART = {
    "type": "file",
    "file": {
        "filename": "example.txt",
        "path": "examples/mem_reader/text1.txt",
    },
}

# ============================================================================
# 6. Text Content Samples (for TextContentParser Demo)
# ============================================================================

TEXT_CONTENT_PARTS = [
    {"type": "text", "text": "This is a simple text content part."},
    {"type": "text", "text": "TextContentParser handles text parts in multimodal messages."},
]

# ============================================================================
# 7. System Message Samples (for SystemParser Demo)
# ============================================================================

SYSTEM_MESSAGE_CASES = [
    TestCase(
        name="system_simple",
        description="Simple text system message",
        scene_data=[
            {
                "role": "system",
                "content": "You are a helpful assistant that provides clear and concise answers.",
                "chat_time": "2025-01-15T10:00:00",
                "message_id": "msg_001",
            }
        ],
    ),
    TestCase(
        name="system_multimodal",
        description="Multimodal system message (multiple text parts)",
        scene_data=[
            {
                "role": "system",
                "content": [
                    {"type": "text", "text": "You are a helpful assistant."},
                    {"type": "text", "text": "Always provide clear and concise answers."},
                    {"type": "text", "text": "If you don't know something, say so."},
                ],
                "chat_time": "2025-01-15T10:05:00",
                "message_id": "msg_002",
            }
        ],
    ),
    TestCase(
        name="system_structured",
        description="Structured system instructions (multiple text parts)",
        scene_data=[
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "You are a coding assistant specialized in Python programming.",
                    },
                    {"type": "text", "text": "Always write clean, well-documented code."},
                    {"type": "text", "text": "Explain your reasoning when providing solutions."},
                ],
                "chat_time": "2025-01-15T10:10:00",
                "message_id": "msg_003",
            }
        ],
    ),
]

# ============================================================================
# 8. User Message Samples (for UserParser Demo)
# ============================================================================

USER_MESSAGE_CASES = [
    TestCase(
        name="user_simple",
        description="Simple text user message",
        scene_data=[
            {
                "role": "user",
                "content": "I'm feeling a bit down today. Can you help me?",
                "chat_time": "2025-01-15T10:00:00",
                "message_id": "msg_001",
            }
        ],
    ),
    TestCase(
        name="user_multimodal",
        description="Multimodal user message (text + file)",
        scene_data=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Please analyze this document:"},
                    {
                        "type": "file",
                        "file": {
                            "filename": "report.pdf",
                            "file_id": "file_123",
                            "file_data": "This is the content of the PDF file...",
                        },
                    },
                ],
                "chat_time": "2025-01-15T10:05:00",
                "message_id": "msg_002",
            }
        ],
    ),
    TestCase(
        name="user_image",
        description="User message with image",
        scene_data=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What's in this image?"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}},
                ],
                "chat_time": "2025-01-15T10:10:00",
                "message_id": "msg_003",
            }
        ],
    ),
]

# ============================================================================
# 9. Assistant Message Samples (for AssistantParser Demo)
# ============================================================================

ASSISTANT_MESSAGE_CASES = [
    TestCase(
        name="assistant_simple",
        description="Simple support message",
        scene_data=[
            {
                "role": "assistant",
                "content": "I'm sorry to hear that you're feeling down. Would you like to talk about what's been going on?",
                "chat_time": "2025-01-15T10:00:30",
                "message_id": "msg_001",
            }
        ],
    ),
    TestCase(
        name="assistant_analysis",
        description="Document analysis response",
        scene_data=[
            {
                "role": "assistant",
                "content": "Based on the document you provided, I can see several key points: 1) The project timeline, 2) Budget considerations, and 3) Resource allocation.",
                "chat_time": "2025-01-15T10:05:30",
                "message_id": "msg_002",
            }
        ],
    ),
    TestCase(
        name="assistant_code",
        description="Code solution",
        scene_data=[
            {
                "role": "assistant",
                "content": "Here's a Python solution for your problem:\n```python\ndef solve_problem():\n    return 'solution'\n```",
                "chat_time": "2025-01-15T10:10:30",
                "message_id": "msg_003",
            }
        ],
    ),
]

# ============================================================================
# 10. Image Samples (for ImageParser Demo)
# ============================================================================

IMAGE_MESSAGE_CASES = [
    {
        "type": "image_url",
        "image_url": {
            "url": "https://statics.memtensor.com.cn/memos/memos-banner.gif",
            "detail": "auto",
        },
        "_note": "Real Image (MemOS Banner)",
    },
    {
        "type": "image",
        "image_url": "https://example.com/image2.png",
        "_note": "Dummy Image (Negative Test)",
    },
]

# ============================================================================
# 11. Multimodal Message Cases (from Legacy)
# ============================================================================

MULTIMODAL_MESSAGE_CASES = [
    TestCase(
        name="multimodal_text_image",
        description="User message with text and image",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "帮我看看这张图片大概是什么内容？"},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "https://example.com/mountain_lake.jpg",
                                "detail": "high",
                            },
                        },
                    ],
                    "chat_time": "2025-11-24T10:20:00Z",
                    "message_id": "mm-img-1",
                }
            ]
        ],
    ),
    TestCase(
        name="multimodal_text_file",
        description="User message with text and file",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请阅读这个PDF，总结里面的要点。"},
                        {"type": "file", "file": {"file_id": "file_123", "filename": "report.pdf"}},
                    ],
                    "chat_time": "2025-11-24T10:21:00Z",
                    "message_id": "mm-file-1",
                }
            ]
        ],
    ),
    TestCase(
        name="oss_text_file",
        description="User message with text and file",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请阅读这个PDF，总结里面的要点。"},
                        {
                            "type": "file",
                            "file": {
                                "file_id": "file_123",
                                "filename": "report.pdf",
                                "file_data": "@http://139.196.232.20:9090/graph-test/algorithm/2025_11_13/1763043889_1763043782_PM1%E8%BD%A6%E9%97%B4PMT%E9%9D%B4%E5%8E%8B%E8%BE%B9%E5%8E%8B%E5%8E%8B%E5%8A%9B%E6%97%A0%E6%B3%95%E5%BB%BA%E7%AB%8B%E6%95%85%E9%9A%9C%E6%8A%A5%E5%91%8A20240720.md",
                            },
                        },
                    ],
                    "chat_time": "2025-11-24T10:21:00Z",
                    "message_id": "mm-file-1",
                }
            ]
        ],
    ),
    TestCase(
        name="pure_data_file",
        description="User message with text and file",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请阅读这个PDF，总结里面的要点。"},
                        {
                            "type": "file",
                            "file": {
                                "file_id": "file_123",
                                "filename": "report.pdf",
                                "file_data": "明文记忆是系统与用户对话、操作等交互中动态习得，以及外部提供的、可显式管理的结构化知识形态，通常以文档、提示模板、图结构或用户规则等形式存在。它具备编辑性、可共享性与治理友好性，适合存储需要频繁修改、可审计或多方协同使用的信息。 在 MemOS 中，明文记忆可用于动态生成推理上下文、个性化偏好注入、多代理协作共享等场景，成为连接人类输入与模型认知的关键桥梁。激活记忆是指模型在推理过程中产生的瞬时性认知状态，包括 KV cache、隐藏层激活、注意力权重等中间张量结构。它通常用于维持上下文连续性、对话一致性与行为风格控制。 MemOS 将激活记忆抽象为可调度资源，支持按需唤醒、延迟卸载与结构变换。例如，某些上下文状态可以被压缩为“半结构化记忆片段”用于未来复用，也可以在任务级别转化为参数化模块，支持短期记忆的长期化演进。这一机制为模型行为一致性、风格保持与状态持续性提供了基础。",
                            },
                        },
                    ],
                    "chat_time": "2025-11-24T10:21:00Z",
                    "message_id": "mm-file-1",
                }
            ]
        ],
    ),
    TestCase(
        name="local_data_file",
        description="User message with text and file",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请阅读这个PDF，总结里面的要点。"},
                        {
                            "type": "file",
                            "file": {
                                "file_id": "file_123",
                                "filename": "report.pdf",
                                "file_data": "./my_local_file/report.pdf",
                            },
                        },
                    ],
                    "chat_time": "2025-11-24T10:21:00Z",
                    "message_id": "mm-file-1",
                }
            ]
        ],
    ),
    TestCase(
        name="internet_file",
        description="User message with text and file",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请阅读这个PDF，总结里面的要点。"},
                        {
                            "type": "file",
                            "file": {
                                "file_id": "file_123",
                                "filename": "report.pdf",
                                "file_data": "https://upload.wikimedia.org/wikipedia/commons/c/cb/NLC416-16jh004830-88775_%E7%B4%85%E6%A8%93%E5%A4%A2.pdf",
                            },
                        },
                    ],
                    "chat_time": "2025-11-24T10:21:00Z",
                    "message_id": "mm-file-1",
                }
            ]
        ],
    ),
    TestCase(
        name="multimodal_mixed",
        description="Mixed multimodal message (text + file + image)",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请同时分析这个报告和图表。"},
                        {
                            "type": "file",
                            "file": {"file_id": "file_789", "filename": "analysis_report.pdf"},
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": "https://example.com/chart.png", "detail": "auto"},
                        },
                    ],
                    "chat_time": "2025-11-24T10:23:00Z",
                    "message_id": "mixed-1",
                }
            ]
        ],
    ),
    TestCase(
        name="multimodal_audio",
        description="Audio-only message",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": "base64_encoded_audio_here", "format": "mp3"},
                        }
                    ],
                    "chat_time": "2025-11-24T10:22:00Z",
                    "message_id": "audio-1",
                }
            ]
        ],
    ),
]

# ============================================================================
# 12. Raw Input Cases (from Legacy)
# ============================================================================

RAW_INPUT_CASES = [
    TestCase(
        name="raw_text_items",
        description="Pure text input items without dialog context",
        scene_data=[
            [
                {"type": "text", "text": "这是一段独立的文本输入，没有明确的对话上下文。"},
                {"type": "text", "text": "它依然会被抽取和写入明文记忆。"},
            ]
        ],
    ),
    TestCase(
        name="raw_file_item",
        description="Pure file input by file_id",
        scene_data=[
            [{"type": "file", "file": {"file_id": "file_uploaded_123", "filename": "document.pdf"}}]
        ],
    ),
    TestCase(
        name="file_only_file_id",
        description="File with only file_id parameter",
        scene_data=[[{"type": "file", "file": {"file_id": "file_only_id_123"}}]],
    ),
    TestCase(
        name="file_only_filename",
        description="File with only filename parameter",
        scene_data=[[{"type": "file", "file": {"filename": "document_only.pdf"}}]],
    ),
    TestCase(
        name="file_only_file_data_base64",
        description="File with only file_data (base64 encoded)",
        scene_data=[
            [
                {
                    "type": "file",
                    "file": {
                        "file_data": "data:application/pdf;base64,JVBERi0xLjQKJdPr6eEKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKPD4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQovUmVzb3VyY2VzIDw8Ci9Gb250IDw8Ci9GMSA0IDAgUgo+Pgo+PgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNhCj4+CmVuZG9iag=="
                    },
                }
            ]
        ],
    ),
    TestCase(
        name="file_only_file_data_url",
        description="File with only file_data (URL)",
        scene_data=[
            [{"type": "file", "file": {"file_data": "https://example.com/documents/report.pdf"}}]
        ],
    ),
    TestCase(
        name="file_only_file_data_text",
        description="File with only file_data (plain text content)",
        scene_data=[
            [
                {
                    "type": "file",
                    "file": {
                        "file_data": "This is a plain text file content. It contains multiple lines.\nLine 2 of the file.\nLine 3 of the file."
                    },
                }
            ]
        ],
    ),
    TestCase(
        name="file_file_data_and_file_id",
        description="File with file_data and file_id",
        scene_data=[
            [
                {
                    "type": "file",
                    "file": {
                        "file_data": "https://example.com/documents/data.pdf",
                        "file_id": "file_with_data_123",
                    },
                }
            ]
        ],
    ),
    TestCase(
        name="file_file_data_and_filename",
        description="File with file_data and filename",
        scene_data=[
            [
                {
                    "type": "file",
                    "file": {
                        "file_data": "This is file content with filename.",
                        "filename": "content_file.txt",
                    },
                }
            ]
        ],
    ),
]
