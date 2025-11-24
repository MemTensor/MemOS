#!/usr/bin/env python3
"""
MemOS Product API: /product/add end-to-end examples.

This script demonstrates how to call the MemOS Product Add API
(`/product/add`, mapped to `APIADDRequest`) with ALL supported
message shapes and key options, including:

1. Minimal string message (backward-compatible)
2. Standard chat messages (system/user/assistant)
3. Assistant messages with tool_calls
4. Raw tool messages: tool_description / tool_input / tool_output
5. Multimodal messages: text + image, text + file, audio-only
6. Pure input items without dialog context: text/file
7. Mixed multimodal message with text + file + image
8. Deprecated fields: mem_cube_id, memory_content, doc_path, source
9. Async vs sync + fast/fine add pipeline
10. Feedback add (is_feedback)
11. Add with chat_history only

Each example sends a real POST request to `/product/add`.

NOTE:
- This script assumes your MemOS server is running and router is mounted at `/product`.
- You may need to adjust BASE_URL, USER_ID, MEM_CUBE_ID to fit your environment.
"""

import json

import requests


# ---------------------------------------------------------------------------
# Global config
# ---------------------------------------------------------------------------

BASE_URL = "http://0.0.0.0:8001/product"
HEADERS = {"Content-Type": "application/json"}

# You can change these identifiers if your backend requires pre-registered users/cubes.
USER_ID = "demo_add_user_001"
MEM_CUBE_ID = "demo_add_cube_001"
SESSION_ID = "demo_add_session_001"


def call_add_api(name: str, payload: dict):
    """
    Generic helper to call /product/add and print the payload + response.

    Args:
        name: Logical name of this example, printed in logs.
        payload: JSON payload compatible with APIADDRequest.
    """
    print("=" * 80)
    print(f"[*] Example: {name}")
    print("- Payload:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))

    try:
        resp = requests.post(
            f"{BASE_URL}/add", headers=HEADERS, data=json.dumps(payload), timeout=60
        )
    except Exception as e:
        print(f"- Request failed with exception: {e!r}")
        print("=" * 80)
        print()
        return

    print("- Response:")
    print(resp.status_code, resp.text)
    print("=" * 80)
    print()


# ===========================================================================
# 1. Minimal / backward-compatible examples
# ===========================================================================


def example_01_string_message_minimal():
    """
    Minimal example using `messages` as a pure string (MessagesType = str).

    - This is the most backward-compatible form.
    - Internally the server will convert this into a text message.
    - Async add is used by default (`async_mode` defaults to "async").
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": "今天心情不错，喝了咖啡。",
    }
    call_add_api("01_string_message_minimal", payload)


def example_02_standard_chat_triplet():
    """
    Standard chat conversation: system + user + assistant.

    - `messages` is a list of role-based chat messages (MessageList).
    - Uses system context + explicit timestamps and message_id.
    - This is recommended when you already have structured dialog.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": SESSION_ID,
        "messages": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "You are a helpful travel assistant.",
                    }
                ],
                "chat_time": "2025-11-24T10:00:00Z",
                "message_id": "sys-1",
            },
            {
                "role": "user",
                "content": "我喜欢干净但不奢华的酒店，比如全季或者亚朵。",
                "chat_time": "2025-11-24T10:00:10Z",
                "message_id": "u-1",
            },
            {
                "role": "assistant",
                "content": "好的，我会优先推荐中端连锁酒店，例如全季、亚朵。",
                "chat_time": "2025-11-24T10:00:15Z",
                "message_id": "a-1",
            },
        ],
        "custom_tags": ["travel", "hotel_preference"],
        "info": {
            "agent_id": "demo_agent",
            "app_id": "demo_app",
            "source_type": "chat",
            "source_url": "https://example.com/dialog/standard",
        },
    }
    call_add_api("02_standard_chat_triplet", payload)


# ===========================================================================
# 2. Tool / function-calling related examples
# ===========================================================================


def example_03_assistant_with_tool_calls():
    """
    Assistant message containing tool_calls (function calls).

    - `role = assistant`, `content = None`.
    - `tool_calls` contains a list of function calls with arguments.
    - This matches OpenAI-style function calling structure.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
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
        ],
    }
    call_add_api("03_assistant_with_tool_calls", payload)


# ===========================================================================
# 4. MultiModel messages
# ===========================================================================


def example_04_extreme_multimodal_single_message():
    """
    Extreme multimodal message:
    text + image_url + file + audio (in one message).
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "请分析下面这些信息："},
                    {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
                    {"type": "file", "file": {"file_id": "f1", "filename": "xx.pdf"}},
                ],
                "chat_time": "2025-11-24T10:55:00Z",
                "message_id": "mix-mm-1",
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "请再分析一下下面这些信息："},
                    {"type": "file", "file": {"file_id": "f1", "filename": "xx.pdf"}},
                ],
                "chat_time": "2025-11-24T10:55:00Z",
                "message_id": "mix-mm-1",
            },
        ],
        "info": {"source_type": "extreme_multimodal"},
    }
    call_add_api("18_extreme_multimodal_single_message", payload)


# ===========================================================================
# 3. Multimodal messages
# ===========================================================================


def example_05_multimodal_text_and_image():
    """
    Multimodal user message: text + image_url.

    - `content` is a list of content parts.
    - Each part can be text/image_url/... etc.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "帮我看看这张图片大概是什么内容？",
                    },
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
        ],
        "info": {"source_type": "image_analysis"},
    }
    call_add_api("05_multimodal_text_and_image", payload)


def example_06_multimodal_text_and_file():
    """
    Multimodal user message: text + file (file_id based).

    - Typically used when the file is already uploaded and you only store the reference.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "请阅读这个PDF，总结里面的要点。",
                    },
                    {
                        "type": "file",
                        "file": {
                            "file_id": "file_123",
                            "filename": "report.pdf",
                        },
                    },
                ],
                "chat_time": "2025-11-24T10:21:00Z",
                "message_id": "mm-file-1",
            }
        ],
        "info": {"source_type": "file_summary"},
    }
    call_add_api("06_multimodal_text_and_file", payload)


def example_07_audio_only_message():
    """
    Audio-only user message.

    - `content` contains only an input_audio item.
    - `data` is assumed to be base64 encoded audio content.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": "base64_encoded_audio_here",
                            "format": "mp3",
                        },
                    }
                ],
                "chat_time": "2025-11-24T10:22:00Z",
                "message_id": "audio-1",
            }
        ],
        "info": {"source_type": "voice_note"},
    }
    call_add_api("07_audio_only_message", payload)


# ===========================================================================
# 4. Pure input items without dialog context
# ===========================================================================


def example_08_pure_text_input_items():
    """
    Pure text input items without dialog context.

    - This shape is used when there is no explicit dialog.
    - `messages` is a list of raw input items, not role-based messages.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "type": "text",
                "text": "这是一段独立的文本输入，没有明确的对话上下文。",
            },
            {
                "type": "text",
                "text": "它依然会被抽取和写入明文记忆。",
            },
        ],
        "info": {"source_type": "batch_import"},
    }
    call_add_api("08_pure_text_input_items", payload)


def example_09_pure_file_input_by_path():
    """
    Pure file input item using local file path.

    - This is equivalent to the deprecated `doc_path` field, but preferred
      in the new design (as a structured file input).
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "type": "file",
                "file": {
                    "path": "/path/to/local/document.pdf",
                    "filename": "document.pdf",
                },
            }
        ],
        "info": {"source_type": "local_file_ingestion"},
    }
    call_add_api("09_pure_file_input_by_path", payload)


def example_10_mixed_text_file_image():
    """
    Mixed multimodal message: text + file + image in a single user message.

    - This is the most general form of `content` as a list of content parts.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "请同时分析这个报告和图表。",
                    },
                    {
                        "type": "file",
                        "file": {
                            "file_id": "file_789",
                            "filename": "analysis_report.pdf",
                        },
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "https://example.com/chart.png",
                            "detail": "auto",
                        },
                    },
                ],
                "chat_time": "2025-11-24T10:23:00Z",
                "message_id": "mixed-1",
            }
        ],
        "info": {"source_type": "report_plus_chart"},
    }
    call_add_api("10_mixed_text_file_image", payload)


# ===========================================================================
# 5. Deprecated fields: mem_cube_id, memory_content, doc_path, source
# ===========================================================================


def example_11_deprecated_memory_content_and_doc_path():
    """
    Use only deprecated fields to demonstrate the conversion logic:

    - `mem_cube_id`: will be converted to `writable_cube_ids` if missing.
    - `memory_content`: will be converted into a text message and appended to `messages`.
    - `doc_path`: will be converted into a file input item and appended to `messages`.
    - `source`: will be moved into `info['source']` if not already set.

    This example intentionally omits `writable_cube_ids` and `messages`,
    so that the @model_validator in APIADDRequest does all the work.
    """
    payload = {
        "user_id": USER_ID,
        "mem_cube_id": MEM_CUBE_ID,  # deprecated
        "memory_content": "这是通过 memory_content 写入的老字段内容。",  # deprecated
        "doc_path": "/path/to/legacy.docx",  # deprecated
        "source": "legacy_source_tag",  # deprecated
        "session_id": "session_deprecated_1",
        "async_mode": "async",
    }
    call_add_api("11_deprecated_memory_content_and_doc_path", payload)


# ===========================================================================
# 6. Async vs Sync, fast/fine modes
# ===========================================================================


def example_12_async_default_pipeline():
    """
    Default async add pipeline.

    - `async_mode` is omitted, so it defaults to "async".
    - `mode` is ignored in async mode even if set (we keep it None here).
    - This is the recommended pattern for most production traffic.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": "session_async_default",
        "messages": "今天我在测试异步添加记忆。",
        "custom_tags": ["async", "default"],
        "info": {"source_type": "chat"},
    }
    call_add_api("12_async_default_pipeline", payload)


def example_13_sync_fast_pipeline():
    """
    Sync add with fast pipeline.

    - `async_mode = "sync"`, `mode = "fast"`.
    - This is suitable for high-throughput or latency-sensitive ingestion
      where you want lighter extraction logic.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": "session_sync_fast",
        "async_mode": "sync",
        "mode": "fast",
        "messages": [
            {
                "role": "user",
                "content": "这条记忆使用 sync + fast 模式写入。",
            }
        ],
        "custom_tags": ["sync", "fast"],
        "info": {"source_type": "api_test"},
    }
    call_add_api("13_sync_fast_pipeline", payload)


def example_14_sync_fine_pipeline():
    """
    Sync add with fine pipeline.

    - `async_mode = "sync"`, `mode = "fine"`.
    - This is suitable for scenarios where quality of extraction is more
      important than raw throughput.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": "session_sync_fine",
        "async_mode": "sync",
        "mode": "fine",
        "messages": [
            {
                "role": "user",
                "content": "这条记忆使用 sync + fine 模式写入，需要更精细的抽取。",
            }
        ],
        "custom_tags": ["sync", "fine"],
        "info": {"source_type": "api_test"},
    }
    call_add_api("14_sync_fine_pipeline", payload)


def example_15_async_with_task_id():
    """
    Async add with explicit task_id.

    - `task_id` can be used to correlate this async add request with
      downstream scheduler status or monitoring.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": "session_async_task",
        "async_mode": "async",
        "task_id": "task_async_001",
        "messages": [
            {
                "role": "user",
                "content": "这是一条带有 task_id 的异步写入请求。",
            }
        ],
        "custom_tags": ["async", "task_id"],
        "info": {"source_type": "task_test"},
    }
    call_add_api("15_async_with_task_id", payload)


# ===========================================================================
# 7. Feedback and chat_history examples
# ===========================================================================


def example_16_feedback_add():
    """
    Feedback add example.

    - `is_feedback = True` marks this add as user feedback.
    - You can use `custom_tags` and `info` to label the feedback type/source.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": "session_feedback_1",
        "is_feedback": True,
        "messages": [
            {
                "role": "user",
                "content": "刚才那个酒店推荐不太符合我的预算，请给我更便宜一点的选项。",
                "chat_time": "2025-11-24T10:30:00Z",
                "message_id": "fb-1",
            }
        ],
        "custom_tags": ["feedback", "hotel"],
        "info": {
            "source_type": "chat_feedback",
            "feedback_type": "preference_correction",
        },
    }
    call_add_api("16_feedback_add", payload)


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    # You can comment out some examples if you do not want to run all of them.
    example_01_string_message_minimal()
    example_02_standard_chat_triplet()
    example_03_assistant_with_tool_calls()
    example_05_multimodal_text_and_image()
    example_06_multimodal_text_and_file()
    example_07_audio_only_message()
    example_08_pure_text_input_items()
    example_09_pure_file_input_by_path()
    example_10_mixed_text_file_image()
    example_11_deprecated_memory_content_and_doc_path()
    example_12_async_default_pipeline()
    example_13_sync_fast_pipeline()
    example_14_sync_fine_pipeline()
    example_15_async_with_task_id()
    example_16_feedback_add()
