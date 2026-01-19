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

BASE_URL = "http://127.0.0.1:8000/product"
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
        "messages": [
            {
                "role": "user",
                "content": "今天心情不错，喝了咖啡。",
            }
        ],
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
                "content": "You are a helpful travel assistant.",
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
                "content": '[Tool Call] get_weather({"location": "北京"})',
                "chat_time": "2025-11-24T10:12:00Z",
                "message_id": "assistant-with-call-1",
            }
        ],
    }
    call_add_api("03_assistant_with_tool_calls", payload)


# ===========================================================================
# 4. MultiModel messages
def example_03b_tool_message_with_result():
    """
    Tool message returning the result of a tool call.

    - `role = tool`, `content` contains the tool execution result.
    - `tool_call_id` links this message to the original tool call.
    - This is the standard format for tool execution results in OpenAI-style conversations.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "assistant",
                "content": '[Tool Call] get_weather({"location": "北京"})',
                "chat_time": "2025-11-24T10:12:00Z",
                "message_id": "assistant-with-call-1",
            },
            {
                "role": "system",
                "content": "[Tool Result] 北京今天天气晴朗，温度25°C，湿度60%。",
                "chat_time": "2025-11-24T10:12:05Z",
                "message_id": "tool-result-1",
            },
        ],
        "info": {"source_type": "tool_execution"},
    }
    call_add_api("03b_tool_message_with_result", payload)


def example_03c_tool_description_input_output():
    """
    Custom tool message format: tool_description, tool_input, tool_output.

    - This demonstrates the custom tool message format (not OpenAI standard).
    - `tool_description`: describes the tool/function definition.
    - `tool_input`: the input parameters for the tool call.
    - `tool_output`: the result/output from the tool execution.
    - These are alternative formats for representing tool interactions.
    """
    tool_desc = {
        "type": "tool_description",
        "name": "get_weather",
        "description": "获取指定地点的当前天气信息",
        "parameters": {
            "type": "object",
            "properties": {"location": {"type": "string", "description": "城市名称"}},
            "required": ["location"],
        },
    }
    tool_input = {
        "type": "tool_input",
        "call_id": "call_123",
        "name": "get_weather",
        "argument": {"location": "北京"},
    }
    tool_output = {
        "type": "tool_output",
        "call_id": "call_123",
        "name": "get_weather",
        "output": {"weather": "晴朗", "temperature": 25, "humidity": 60},
    }

    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "system",
                "content": f"[Tool Description] {json.dumps(tool_desc, ensure_ascii=False)}",
            },
            {
                "role": "user",
                "content": f"[Tool Input] {json.dumps(tool_input, ensure_ascii=False)}",
            },
            {
                "role": "system",
                "content": f"[Tool Output] {json.dumps(tool_output, ensure_ascii=False)}",
            },
        ],
        "info": {"source_type": "custom_tool_format"},
    }
    call_add_api("03c_tool_description_input_output", payload)


# ===========================================================================
# 4. Multimodal messages
# ===========================================================================


def example_04_extreme_multimodal_single_message():
    """
    Extreme multimodal message:
    text + image_url + file in one message, and another message with text + file.

    Note: This demonstrates multiple multimodal messages in a single request.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": "请分析下面这些信息：\n[Image: https://example.com/x.png]\n[File: xx.pdf]",
                "chat_time": "2025-11-24T10:55:00Z",
                "message_id": "mix-mm-1",
            },
            {
                "role": "user",
                "content": "请再分析一下下面这些信息：\n[File: xx.pdf]",
                "chat_time": "2025-11-24T10:55:10Z",
                "message_id": "mix-mm-2",
            },
        ],
        "info": {"source_type": "extreme_multimodal"},
    }
    call_add_api("04_extreme_multimodal_single_message", payload)


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
                "content": "帮我看看这张图片大概是什么内容？\n[Image: https://example.com/mountain_lake.jpg]",
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

    - Uses `file_id` when the file has already been uploaded.
    - Note: According to FileFile type definition (TypedDict, total=False),
      all fields (`file_id`, `file_data`, `filename`) are optional.
      However, in practice, you typically need at least `file_id` OR `file_data`
      to specify the file location.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": "请阅读这个PDF，总结里面的要点。\n[File: report.pdf (ID: file_123)]",
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
                "content": "[Audio Input: base64_encoded_audio_here (mp3)]",
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
                "role": "user",
                "content": "这是一段独立的文本输入，没有明确的对话上下文。",
            },
            {
                "role": "user",
                "content": "它依然会被抽取和写入明文记忆。",
            },
        ],
        "info": {"source_type": "batch_import"},
    }
    call_add_api("08_pure_text_input_items", payload)


def example_09_pure_file_input_by_file_id():
    """
    Pure file input item using file_id (standard format).

    - Uses `file_id` when the file has already been uploaded.
    - Note: All FileFile fields are optional (TypedDict, total=False):
      * `file_id`: optional, use when file is already uploaded
      * `file_data`: optional, use for base64-encoded content
      * `filename`: optional, but recommended for clarity
      - In practice, you need at least `file_id` OR `file_data` to specify the file.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": "[File: document.pdf (ID: file_uploaded_123)]",
            }
        ],
        "info": {"source_type": "file_ingestion"},
    }
    call_add_api("09_pure_file_input_by_file_id", payload)


def example_09b_pure_file_input_by_file_data():
    """
    Pure file input item using file_data (base64 encoded).

    - Uses `file_data` with base64-encoded file content.
    - This is the standard format for direct file input without uploading first.
    - Note: `file_data` is optional in type definition, but required here
      since we're not using `file_id`. At least one of `file_id` or `file_data`
      should be provided in practice.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": "[File: document.pdf (base64_data)]",
            }
        ],
        "info": {"source_type": "file_ingestion_base64"},
    }
    call_add_api("09b_pure_file_input_by_file_data", payload)


def example_09c_pure_file_input_by_oss_url():
    """
    Pure file input item using file_data with OSS URL.

    - Uses `file_data` with OSS URL (object storage service URL).
    - This format is used when files are stored in cloud storage (e.g., Alibaba Cloud OSS).
    - The file_data field accepts both base64-encoded content and OSS URLs.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": "[File: document.pdf (OSS: oss_url)]",
            }
        ],
        "info": {"source_type": "file_ingestion_oss"},
    }
    call_add_api("09c_pure_file_input_by_oss_url", payload)


def example_09d_pure_image_input():
    """
    Pure image input item without dialog context.

    - This demonstrates adding an image as a standalone input item (not part of a conversation).
    - Uses the same format as pure text/file inputs, but with image_url type.
    - Useful for batch image ingestion or when images don't have associated dialog.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": "[Image: https://example.com/standalone_image.jpg]",
            }
        ],
        "info": {"source_type": "image_ingestion"},
    }
    call_add_api("09d_pure_image_input", payload)


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
                "content": "请同时分析这个报告和图表。\n[File: analysis_report.pdf (ID: file_789)]\n[Image: https://example.com/chart.png]",
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


def example_17_family_travel_conversation():
    """
    Multi-turn conversation example: family travel planning.

    - Demonstrates a complete conversation with multiple user-assistant exchanges.
    - Shows how to add a full conversation history in a single request.
    - Uses async_mode for asynchronous processing.
    - This example shows a Chinese conversation about summer travel planning for families.
    """
    payload = {
        "user_id": "memos_automated_testing",
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": "0610",
        "async_mode": "async",
        "messages": [
            {
                "role": "user",
                "content": "我想暑假出去玩，你能帮我推荐下吗？",
            },
            {
                "role": "assistant",
                "content": "好的！是自己出行还是和家人朋友一起呢？",
            },
            {
                "role": "user",
                "content": "肯定要带孩子啊，我们家出门都是全家一起。",
            },
            {
                "role": "assistant",
                "content": "明白了，所以你们是父母带孩子一块儿旅行，对吗？",
            },
            {
                "role": "user",
                "content": "对，带上孩子和老人，一般都是全家行动。",
            },
            {
                "role": "assistant",
                "content": "收到，那我会帮你推荐适合家庭出游的目的地。",
            },
        ],
        "custom_tags": [],
        "info": {
            "source_type": "chat",
            "conversation_id": "0610",
        },
    }
    call_add_api("17_family_travel_conversation", payload)


def example_18_add_with_chat_history():
    """
    Add memory with chat_history field.

    - `chat_history` provides additional conversation context separate from `messages`.
    - This is useful when you want to add specific messages while providing broader context.
    - The chat_history helps the system understand the conversation flow better.
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "session_id": "session_with_history",
        "messages": [
            {
                "role": "user",
                "content": "我想了解一下这个产品的价格。",
            },
            {
                "role": "assistant",
                "content": "好的，我来为您查询价格信息。",
            },
        ],
        "chat_history": [
            {
                "role": "system",
                "content": "You are a helpful product assistant.",
            },
            {
                "role": "user",
                "content": "你好，我想咨询产品信息。",
            },
            {
                "role": "assistant",
                "content": "您好！我很乐意为您提供产品信息。",
            },
        ],
        "info": {"source_type": "chat_with_history"},
    }
    call_add_api("18_add_with_chat_history", payload)


# ===========================================================================
# 8. Search and Chat examples
# ===========================================================================


def example_19_search_memories():
    """
    Search memories using `APISearchRequest`.

    - Searches for memories relevant to a query.
    - Demonstrates usage of `readable_cube_ids` for scoping.
    """
    payload = {
        "user_id": USER_ID,
        "query": "What are my hotel preferences?",
        "readable_cube_ids": [MEM_CUBE_ID],
        "top_k": 5,
        "mode": "fast",
        "include_preference": True,
    }

    print("=" * 80)
    print("[*] Example: 19_search_memories")
    print("- Payload:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))

    try:
        resp = requests.post(
            f"{BASE_URL}/search", headers=HEADERS, data=json.dumps(payload), timeout=60
        )
        print("- Response:")
        print(resp.status_code, resp.text)
    except Exception as e:
        print(f"- Request failed with exception: {e!r}")

    print("=" * 80)
    print()


def example_20_chat_complete():
    """
    Chat completion using `APIChatCompleteRequest`.

    - Sends a chat query to the system.
    - System retrieves relevant memories and generates a response.
    - please make sure ENABLE_CHAT_API=true in .env or environment variables
    - and set up CHAT_MODEL_LIST in .env or environment variables properly with api keys and stuff.
    """
    payload = {
        "user_id": USER_ID,
        "query": "Recommend a hotel for me based on my preferences.",
        "readable_cube_ids": [MEM_CUBE_ID],
        "writable_cube_ids": [MEM_CUBE_ID],
        "mode": "fast",
        "top_k": 5,
        "add_message_on_answer": True,
    }

    print("=" * 80)
    print("[*] Example: 20_chat_complete")
    print("- Payload:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))

    try:
        resp = requests.post(
            f"{BASE_URL}/chat/complete", headers=HEADERS, data=json.dumps(payload), timeout=60
        )
        print("- Response:")
        print(resp.status_code, resp.text)
    except Exception as e:
        print(f"- Request failed with exception: {e!r}")

    print("=" * 80)
    print()


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    # You can comment out some examples if you do not want to run all of them.
    example_01_string_message_minimal()
    example_02_standard_chat_triplet()
    example_03_assistant_with_tool_calls()
    example_03b_tool_message_with_result()
    example_03c_tool_description_input_output()
    example_04_extreme_multimodal_single_message()
    example_05_multimodal_text_and_image()
    example_06_multimodal_text_and_file()
    example_07_audio_only_message()
    example_08_pure_text_input_items()
    example_09_pure_file_input_by_file_id()
    example_09b_pure_file_input_by_file_data()
    example_09c_pure_file_input_by_oss_url()
    example_09d_pure_image_input()
    example_10_mixed_text_file_image()
    example_11_deprecated_memory_content_and_doc_path()
    example_12_async_default_pipeline()
    example_13_sync_fast_pipeline()
    example_14_sync_fine_pipeline()
    example_15_async_with_task_id()
    example_16_feedback_add()
    example_17_family_travel_conversation()
    example_18_add_with_chat_history()
    example_19_search_memories()
    example_20_chat_complete()
