#!/usr/bin/env python3
"""
MultiModalStructMemReader Example Script

This script demonstrates various use cases for MultiModalStructMemReader,
including different message types, modes (fast/fine), and output formats.

Usage:
    python multimodal_struct_reader.py --example all
    python multimodal_struct_reader.py --example string_message --mode fast
    python multimodal_struct_reader.py --example multimodal --format json
"""

import argparse
import json
import os
import sys
import time

from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from memos.configs.mem_reader import MultiModalStructMemReaderConfig
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.memories.textual.item import TextualMemoryItem


# Add src directory to path
src_path = Path(__file__).parent.parent.parent / "src"
sys.path.insert(0, str(src_path))

# Load environment variables
load_dotenv()


# ============================================================================
# Test Case Definitions
# ============================================================================


class TestCase:
    """Base class for test cases."""

    def __init__(
        self,
        name: str,
        description: str,
        scene_data: Any,
        expected_count: dict[str, int] | None = None,
    ):
        """
            Initialize a test case.

        Args:
                name: Test case name
                description: Test case description
                scene_data: Scene data to test
                expected_count: Expected memory count for each mode (optional)
        """
        self.name = name
        self.description = description
        self.scene_data = scene_data
        self.expected_count = expected_count or {}

    def get_info(self) -> dict[str, Any]:
        """Get info dict for this test case."""
        return {
            "user_id": "test_user",
            "session_id": f"session_{self.name}",
            "test_case": self.name,
        }


# String message test cases
STRING_MESSAGE_CASES = [
    TestCase(
        name="string_simple",
        description="Simple string message",
        scene_data=["今天心情不错，喝了咖啡。"],
        expected_count={"fast": 1, "fine": 1},  # StringParser returns [] in
        # fast mode
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

# Standard chat message test cases
CHAT_MESSAGE_CASES = [
    TestCase(
        name="chat_simple",
        description="Simple chat conversation",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": "Hello, how are you?",
                    "chat_time": "2025-01-01T10:00:00Z",
                },
                {
                    "role": "assistant",
                    "content": "I'm doing well, thank you!",
                    "chat_time": "2025-01-01T10:00:01Z",
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
                    "content": [{"type": "text", "text": "You are a helpful assistant."}],
                    "chat_time": "2025-01-01T10:00:00Z",
                },
                {
                    "role": "user",
                    "content": "What's the weather?",
                    "chat_time": "2025-01-01T10:00:01Z",
                },
                {
                    "role": "assistant",
                    "content": "I don't have access to weather data.",
                    "chat_time": "2025-01-01T10:00:02Z",
                },
            ]
        ],
    ),
    TestCase(
        name="chat_long_conversation",
        description="Long conversation with multiple turns",
        scene_data=[
            [
                {
                    "role": "user",
                    "chat_time": "3 May 2025",
                    "content": "I'm feeling a bit down today.",
                },
                {
                    "role": "assistant",
                    "chat_time": "3 May 2025",
                    "content": "I'm sorry to hear that. Do you want to talk about what's been going on?",
                },
                {
                    "role": "user",
                    "chat_time": "3 May 2025",
                    "content": "It's just been a tough couple of days.",
                },
                {
                    "role": "assistant",
                    "chat_time": "3 May 2025",
                    "content": "It sounds like you're going through a lot right now.",
                },
            ]
        ],
    ),
    TestCase(
        name="chat_with_list_content",
        description="",
        scene_data=[
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "我是测试base64",
                        },
                        {
                            "type": "file",
                            "file": {
                                "file_data": "Hello World",
                                "filename": "2102b64c-25a2-481c-a940-4325496baf39.txt",
                                "file_id": "90ee1bcf-5295-4b75-91a4-23fe1f7ab30a",
                            },
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "https://play-groud-test-1.oss-cn-shanghai.aliyuncs.com/algorithmImages/2025/12/01/ce545319ba6d4d21a0aebcb75337acc3.jpeg"
                            },
                        },
                    ],
                    "message_id": "1995458892790317057",
                }
            ]
        ],
    ),
]

# Tool-related test cases
TOOL_MESSAGE_CASES = [
    TestCase(
        name="tool_assistant_with_calls",
        description="Assistant message with tool_calls",
        scene_data=[
            [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "tool-call-weather-1",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": '{"location": "北京"}',
                            },
                        }
                    ],
                    "chat_time": "2025-11-24T10:12:00Z",
                    "message_id": "assistant-with-call-1",
                }
            ]
        ],
    ),
    TestCase(
        name="tool_with_result",
        description="Tool call with result message",
        scene_data=[
            [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "tool-call-weather-1",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": '{"location": "北京"}',
                            },
                        }
                    ],
                    "chat_time": "2025-11-24T10:12:00Z",
                },
                {
                    "role": "tool",
                    "content": "北京今天天气晴朗，温度25°C，湿度60%。",
                    "tool_call_id": "tool-call-weather-1",
                    "chat_time": "2025-11-24T10:12:05Z",
                },
            ]
        ],
    ),
    TestCase(
        name="tool_custom_format",
        description="Custom tool format (tool_description, tool_input, tool_output)",
        scene_data=[
            [
                {
                    "type": "tool_description",
                    "name": "get_weather",
                    "description": "获取指定地点的当前天气信息",
                    "parameters": {
                        "type": "object",
                        "properties": {"location": {"type": "string", "description": "城市名称"}},
                        "required": ["location"],
                    },
                },
                {
                    "type": "tool_input",
                    "call_id": "call_123",
                    "name": "get_weather",
                    "argument": {"location": "北京"},
                },
                {
                    "type": "tool_output",
                    "call_id": "call_123",
                    "name": "get_weather",
                    "output": {"weather": "晴朗", "temperature": 25, "humidity": 60},
                },
            ]
        ],
    ),
]

# Multimodal message test cases
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

# Raw input item test cases
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
    # File parameter test cases - covering all combinations
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
            [
                {
                    "type": "file",
                    "file": {"file_data": "https://example.com/documents/report.pdf"},
                }
            ]
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
                        "filename": "content_with_name.txt",
                    },
                }
            ]
        ],
    ),
    TestCase(
        name="file_file_id_and_filename",
        description="File with file_id and filename (existing case)",
        scene_data=[
            [{"type": "file", "file": {"file_id": "file_uploaded_123", "filename": "document.pdf"}}]
        ],
    ),
    TestCase(
        name="file_all_parameters",
        description="File with all parameters (file_data, file_id, filename)",
        scene_data=[
            [
                {
                    "type": "file",
                    "file": {
                        "file_data": "https://example.com/documents/complete.pdf",
                        "file_id": "file_complete_123",
                        "filename": "complete_document.pdf",
                    },
                }
            ]
        ],
    ),
    TestCase(
        name="file_no_parameters",
        description="File with no parameters (should return [File: unknown])",
        scene_data=[[{"type": "file", "file": {}}]],
    ),
]

# Assistant message test cases
ASSISTANT_MESSAGE_CASES = [
    TestCase(
        name="assistant_with_refusal",
        description="Assistant message with refusal",
        scene_data=[
            [
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "I can help you with that."}],
                    "refusal": "I cannot provide information about that topic.",
                    "chat_time": "2025-11-24T10:30:00Z",
                }
            ]
        ],
    ),
    TestCase(
        name="assistant_with_audio",
        description="Assistant message with audio",
        scene_data=[
            [
                {
                    "role": "assistant",
                    "content": "Here's the audio response.",
                    "audio": {"id": "audio_response_123"},
                    "chat_time": "2025-11-24T10:31:00Z",
                }
            ]
        ],
    ),
]

# All test cases organized by category
TEST_CASES = {
    "string": STRING_MESSAGE_CASES,
    "chat": CHAT_MESSAGE_CASES,
    "tool": TOOL_MESSAGE_CASES,
    "multimodal": MULTIMODAL_MESSAGE_CASES,
    "raw": RAW_INPUT_CASES,
    "assistant": ASSISTANT_MESSAGE_CASES,
}

# Flattened list of all test cases
ALL_TEST_CASES = {case.name: case for cases in TEST_CASES.values() for case in cases}


# ============================================================================
# Utility Functions
# ============================================================================


def print_textual_memory_item(item: TextualMemoryItem, prefix: str = "", max_length: int = 500):
    """Print a memory item in a readable format."""
    print(f"{prefix}Memory ID: {item.id}")
    print(f"{prefix}Memory Type: {item.metadata.memory_type}")
    if item.metadata.tags:
        print(f"{prefix}Tags: {item.metadata.tags}")
    memory_preview = (
        item.memory[:max_length] + "..." if len(item.memory) > max_length else item.memory
    )
    print(f"{prefix}Memory: {memory_preview}")
    if item.metadata.key:
        print(f"{prefix}Key: {item.metadata.key}")
    if item.metadata.sources:
        sources_count = len(item.metadata.sources) if isinstance(item.metadata.sources, list) else 1
        print(f"{prefix}Sources count: {sources_count}")
    print()


def print_textual_memory_item_json(item: TextualMemoryItem, indent: int = 2):
    """Print a memory item as formatted JSON."""
    data = item.to_dict()
    if "metadata" in data and "embedding" in data["metadata"]:
        embedding = data["metadata"]["embedding"]
        if embedding:
            data["metadata"]["embedding"] = f"[vector of {len(embedding)} dimensions]"
    print(json.dumps(data, indent=indent, ensure_ascii=False))


def get_reader_config() -> dict[str, Any]:
    """
    Get reader configuration from environment variables.

    Returns:
        Configuration dictionary for MultiModalStructMemReaderConfig
    """
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    ollama_api_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")

    # Get LLM backend and config
    llm_backend = os.getenv("MEM_READER_LLM_BACKEND", "openai")
    if llm_backend == "ollama":
        llm_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": os.getenv("MEM_READER_LLM_MODEL", "qwen3:0.6b"),
                "api_base": ollama_api_base,
                "temperature": float(os.getenv("MEM_READER_LLM_TEMPERATURE", "0.0")),
                "remove_think_prefix": os.getenv(
                    "MEM_READER_LLM_REMOVE_THINK_PREFIX", "true"
                ).lower()
                == "true",
                "max_tokens": int(os.getenv("MEM_READER_LLM_MAX_TOKENS", "8192")),
            },
        }
    else:  # openai
        llm_config = {
            "backend": "openai",
            "config": {
                "model_name_or_path": os.getenv("MEM_READER_LLM_MODEL", "gpt-4o-mini"),
                "api_key": openai_api_key or os.getenv("MEMRADER_API_KEY", "EMPTY"),
                "api_base": openai_base_url,
                "temperature": float(os.getenv("MEM_READER_LLM_TEMPERATURE", "0.5")),
                "remove_think_prefix": os.getenv(
                    "MEM_READER_LLM_REMOVE_THINK_PREFIX", "true"
                ).lower()
                == "true",
                "max_tokens": int(os.getenv("MEM_READER_LLM_MAX_TOKENS", "8192")),
            },
        }

    # Get embedder backend and config
    embedder_backend = os.getenv(
        "MEM_READER_EMBEDDER_BACKEND", os.getenv("MOS_EMBEDDER_BACKEND", "ollama")
    )
    if embedder_backend == "universal_api":
        embedder_config = {
            "backend": "universal_api",
            "config": {
                "provider": os.getenv(
                    "MEM_READER_EMBEDDER_PROVIDER", os.getenv("MOS_EMBEDDER_PROVIDER", "openai")
                ),
                "api_key": os.getenv(
                    "MEM_READER_EMBEDDER_API_KEY",
                    os.getenv("MOS_EMBEDDER_API_KEY", openai_api_key or "sk-xxxx"),
                ),
                "model_name_or_path": os.getenv(
                    "MEM_READER_EMBEDDER_MODEL",
                    os.getenv("MOS_EMBEDDER_MODEL", "text-embedding-3-large"),
                ),
                "base_url": os.getenv(
                    "MEM_READER_EMBEDDER_API_BASE",
                    os.getenv("MOS_EMBEDDER_API_BASE", openai_base_url),
                ),
            },
        }
    else:  # ollama
        embedder_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": os.getenv(
                    "MEM_READER_EMBEDDER_MODEL",
                    os.getenv("MOS_EMBEDDER_MODEL", "nomic-embed-text:latest"),
                ),
                "api_base": ollama_api_base,
            },
        }

    # Get direct markdown hostnames from environment variable
    direct_markdown_hostnames = None
    env_hostnames = os.getenv("FILE_PARSER_DIRECT_MARKDOWN_HOSTNAMES", "139.196.232.20")
    if env_hostnames:
        direct_markdown_hostnames = [h.strip() for h in env_hostnames.split(",") if h.strip()]

    return {
        "llm": llm_config,
        "embedder": embedder_config,
        "chunker": {
            "backend": "sentence",
            "config": {
                "tokenizer_or_token_counter": "gpt2",
                "chunk_size": 512,
                "chunk_overlap": 128,
                "min_sentences_per_chunk": 1,
            },
        },
        "direct_markdown_hostnames": direct_markdown_hostnames,
    }


def count_memories(memory_results: list[list[TextualMemoryItem]]) -> int:
    """Count total number of memory items across all scenes."""
    return sum(len(mem_list) for mem_list in memory_results)


# ============================================================================
# Main Functions
# ============================================================================


def run_test_case(
    test_case: TestCase, reader: MultiModalStructMemReader, mode: str = "fast", format: str = "text"
):
    """
    Run a single test case.

    Args:
        test_case: Test case to run
        reader: MultiModalStructMemReader instance
        mode: Processing mode ("fast" or "fine")
        format: Output format ("text" or "json")
    """
    print(f"\n{'=' * 80}")
    print(f"Test Case: {test_case.name}")
    print(f"Description: {test_case.description}")
    print(f"Mode: {mode.upper()}")
    print(f"{'=' * 80}\n")

    info = test_case.get_info()
    start_time = time.time()

    try:
        memory_results = reader.get_memory(test_case.scene_data, type="chat", info=info, mode=mode)
        elapsed_time = time.time() - start_time

        total_count = count_memories(memory_results)
        print(f"✅ Completed in {elapsed_time:.2f}s")
        print(f"📊 Generated {total_count} memory items across {len(memory_results)} scenes\n")

        # Check expected count if provided
        if test_case.expected_count and mode in test_case.expected_count:
            expected = test_case.expected_count[mode]
            if total_count == expected:
                print(f"✅ Expected count matches: {expected}")
            else:
                print(f"⚠️  Expected {expected}, got {total_count}")

        # Print sample results
        print("\nSample Results:")
        print("-" * 80)
        for scene_idx, mem_list in enumerate(memory_results[:3]):  # Show first 3 scenes
            if not mem_list:
                continue
            print(f"\nScene {scene_idx + 1}:")
            for item_idx, item in enumerate(mem_list[:2]):  # Show first 2 items per scene
                print(f"\n  [Item {item_idx + 1}]")
                if format == "json":
                    print_textual_memory_item_json(item, indent=4)
            else:
                print_textual_memory_item(item, prefix="    ", max_length=300)

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback

        traceback.print_exc()


def run_all_test_cases(reader: MultiModalStructMemReader, mode: str = "fast", format: str = "text"):
    """Run all test cases."""
    print(f"\n{'=' * 80}")
    print(f"Running All Test Cases (Mode: {mode.upper()})")
    print(f"{'=' * 80}\n")

    total_cases = len(ALL_TEST_CASES)
    for idx, (name, test_case) in enumerate(ALL_TEST_CASES.items(), 1):
        print(f"\n[{idx}/{total_cases}] Running: {name}")
        run_test_case(test_case, reader, mode=mode, format=format)


def run_category(
    category: str, reader: MultiModalStructMemReader, mode: str = "fast", format: str = "text"
):
    """Run all test cases in a category."""
    if category not in TEST_CASES:
        print(f"❌ Unknown category: {category}")
        print(f"Available categories: {', '.join(TEST_CASES.keys())}")
        return

    cases = TEST_CASES[category]
    print(f"\n{'=' * 80}")
    print(f"Running Category: {category.upper()} ({len(cases)} test cases)")
    print(f"Mode: {mode.upper()}")
    print(f"{'=' * 80}\n")

    for idx, test_case in enumerate(cases, 1):
        print(f"\n[{idx}/{len(cases)}] {test_case.name}")
        run_test_case(test_case, reader, mode=mode, format=format)


def compare_modes(test_case: TestCase, reader: MultiModalStructMemReader, format: str = "text"):
    """Compare fast and fine modes for a test case."""
    print(f"\n{'=' * 80}")
    print(f"Comparing Fast vs Fine Mode: {test_case.name}")
    print(f"{'=' * 80}\n")

    info = test_case.get_info()

    # Fast mode
    print("⚡ FAST Mode:")
    print("-" * 80)
    start_time = time.time()
    fast_results = reader.get_memory(test_case.scene_data, type="chat", info=info, mode="fast")
    fast_time = time.time() - start_time
    fast_count = count_memories(fast_results)
    print(f"Time: {fast_time:.2f}s, Items: {fast_count}")

    # Fine mode
    print("\n🔄 FINE Mode:")
    print("-" * 80)
    start_time = time.time()
    fine_results = reader.get_memory(test_case.scene_data, type="chat", info=info, mode="fine")
    fine_time = time.time() - start_time
    fine_count = count_memories(fine_results)
    print(f"Time: {fine_time:.2f}s, Items: {fine_count}")

    # Comparison
    print("\n📈 Comparison:")
    print(f"   Fast: {fast_time:.2f}s, {fast_count} items")
    print(f"   Fine: {fine_time:.2f}s, {fine_count} items")
    if fast_time > 0:
        print(f"   Speed: {fine_time / fast_time:.1f}x difference")

    # Show samples
    if format == "text":
        print("\n--- Fast Mode Sample (first item) ---")
        if fast_results and fast_results[0]:
            print_textual_memory_item(fast_results[0][0], prefix="  ", max_length=300)

        print("\n--- Fine Mode Sample (first item) ---")
        if fine_results and fine_results[0]:
            print_textual_memory_item(fine_results[0][0], prefix="  ", max_length=300)


def list_test_cases():
    """List all available test cases."""
    print("\n" + "=" * 80)
    print("Available Test Cases")
    print("=" * 80 + "\n")

    for category, cases in TEST_CASES.items():
        print(f"📁 {category.upper()} ({len(cases)} cases):")
        for case in cases:
            print(f"   • {case.name}: {case.description}")
        print()


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Test MultiModalStructMemReader with various use cases",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run all test cases in fast mode
  python multimodal_struct_reader.py --example all --mode fast

  # Run a specific test case
  python multimodal_struct_reader.py --example chat_simple --mode fine

  # Run a category of test cases
  python multimodal_struct_reader.py --example multimodal --mode fast

  # Compare fast vs fine mode
  python multimodal_struct_reader.py --example chat_simple --compare

  # List all available test cases
  python multimodal_struct_reader.py --list

  # Output in JSON format
  python multimodal_struct_reader.py --example chat_simple --format json
        """,
    )

    parser.add_argument(
        "--example",
        type=str,
        default="oss_text_file",
        help="Test case name, category name, or 'all' to run all cases (default: all)",
    )
    parser.add_argument(
        "--mode",
        choices=["fast", "fine"],
        default="fine",
        help="Processing mode: fast (quick) or fine (with LLM) (default: fast)",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: text (readable) or json (structured) (default: text)",
    )
    parser.add_argument(
        "--compare",
        action="store_true",
        help="Compare fast and fine modes (only works with specific test case)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all available test cases and exit",
    )
    parser.add_argument(
        "--max-memory-length",
        type=int,
        default=500,
        help="Maximum length of memory content to display (default: 500)",
    )

    args = parser.parse_args()

    # List test cases and exit
    if args.list:
        list_test_cases()
        return

    # Initialize reader
    print("Initializing MultiModalStructMemReader...")
    try:
        config_dict = get_reader_config()
        reader_config = MultiModalStructMemReaderConfig.model_validate(config_dict)
        reader = MultiModalStructMemReader(reader_config)
        print("✅ Reader initialized\n")
    except Exception as e:
        print(f"❌ Failed to initialize reader: {e}")
        import traceback

        traceback.print_exc()
        return

    # Run test cases
    if args.example == "all":
        run_all_test_cases(reader, mode=args.mode, format=args.format)
    elif args.example in ALL_TEST_CASES:
        test_case = ALL_TEST_CASES[args.example]
        if args.compare:
            compare_modes(test_case, reader, format=args.format)
        else:
            run_test_case(test_case, reader, mode=args.mode, format=args.format)
    elif args.example in TEST_CASES:
        run_category(args.example, reader, mode=args.mode, format=args.format)
    else:
        print(f"❌ Unknown test case or category: {args.example}")
        print("\nAvailable options:")
        print("  Categories:", ", ".join(TEST_CASES.keys()))
        print("  Test cases:", ", ".join(ALL_TEST_CASES.keys()))
        print("\nUse --list to see all available test cases")


if __name__ == "__main__":
    main()
