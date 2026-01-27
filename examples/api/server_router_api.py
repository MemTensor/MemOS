#!/usr/bin/env python3
"""
MemOS Product API: /product/add end-to-end examples.

This script demonstrates how to call the MemOS Product Add API
(`/product/add`, mapped to `APIADDRequest`) with ALL supported
message shapes and key options, including:

1. Minimal string message (backward-compatible)
2. Tool / function-calling related examples
3. Multimodal messages
4. Pure input items without dialog context
5. Deprecated fields: mem_cube_id, memory_content, doc_path, source
6. Feedback and chat_history examples

It also tests the following features:
7. Search and Chat examples

Each example sends a real POST request.

NOTE:
- This script assumes your MemOS server is running and router is mounted at `/product`.
- You may need to adjust BASE_URL, USER_ID, MEM_CUBE_ID to fit your environment.
- Also, the environment variable `MEM_READER_BACKEND=multimodal_struct` is required.
- If you want to test simple_struct memreader, you can go to examples/mem_reader/run_simple.py
"""

import json

import requests


# ---------------------------------------------------------------------------
# Global config
# ---------------------------------------------------------------------------

BASE_URL = "http://127.0.0.1:8001/product"
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


def example_01a_string_message_minimal():
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
    call_add_api("example_01a_string_message_minimal", payload)


def example_01b_standard_chat_triplet():
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
    call_add_api("example_01b_standard_chat_triplet", payload)


def example_01c_sync_fast_minimal():
    """
    Sync fast mode example - immediate response required.
    
    - async_mode="sync": Blocks until processing completes
    - mode="fast": Fast pipeline without LLM call
    - Use case: User needs immediate confirmation
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": "紧急：明天上午10点开会。",
        "async_mode": "sync", 
        "mode": "fast",        
    }
    call_add_api("example_01c_sync_fast_minimal", payload)


def example_01d_sync_fine_detailed():
    """
    Sync fine mode example - high-quality extraction required.
    
    - async_mode="sync": Blocks until processing completes
    - mode="fine": Fine pipeline with LLM analysis
    - Use case: Important information needs deep understanding
    """
    payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": "明年计划去杭州西湖旅游，预算5000元，喜欢安静的酒店。",
        "async_mode": "sync", 
        "mode": "fine",        
        "custom_tags": ["travel", "planning"],
        "info": {
            "priority": "high",
            "source_type": "important_note"
        }
    }
    call_add_api("example_01d_sync_fine_detailed", payload)


# ===========================================================================
# 2. Tool / function-calling related examples
# ===========================================================================


def example_02a_assistant_with_tool_calls():
    """
    Assistant message containing tool_calls (function calls).
    both multi_model_struct and simple_struct memreaders support this format.

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
    call_add_api("example_02a_assistant_with_tool_calls", payload)


def example_02b_tool_message_with_result():
    """
    Tool message returning the result of a tool call.
    only multi_model_struct memreader supports this format.

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
            },
            {
                "role": "tool",
                "content": "北京今天天气晴朗，温度25°C，湿度60%。",
                "tool_call_id": "tool-call-weather-1",
                "chat_time": "2025-11-24T10:12:05Z",
                "message_id": "tool-result-1",
            },
        ],
        "info": {"source_type": "tool_execution"},
    }
    call_add_api("example_02b_tool_message_with_result", payload)


# ===========================================================================
# 3. Multimodal messages
# ===========================================================================


def example_03a_multimodal_text_and_image():
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
    call_add_api("example_03_multimodal_text_and_image", payload)


def example_03b_multimodal_text_and_file():
    """
    Multimodal message: text + file.
    
    - Combines text description with attached document
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
                        "text": "这是旅游计划的详细文档，请帮我保存。",
                    },
                    {
                        "type": "file",
                        "file": {
                            "file_id": "file_travel_plan_123",
                            "filename": "travel_plan.pdf",
                        },
                    },
                ],
                "chat_time": "2025-11-24T10:25:00Z",
                "message_id": "mm-file-1",
            }
        ],
        "info": {"source_type": "document_upload"},
    }
    call_add_api("example_03b_multimodal_text_and_file", payload)


def example_03c_multimodal_image_fine_mode():
    """
    Multimodal message with image in fine mode.

    - `mode="fine"`: Fine pipeline with LLM analysis for detailed understanding
    - Combines text description with image_url for deep analysis
    - Use case: When you need detailed image analysis and understanding
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
                        "text": "这是我最近去的旅游地点，请详细分析一下这个地方的特点和我可能的旅游偏好。",
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "https://example.com/mountain_lake.jpg",
                            "detail": "high",
                        },
                    },
                ],
                "chat_time": "2025-11-24T10:22:00Z",
                "message_id": "mm-img-fine-1",
            }
        ],
        "mode": "fine",
        "async_mode": "sync",
        "custom_tags": ["travel", "image_analysis", "preference"],
        "info": {"source_type": "detailed_image_analysis"},
    }
    call_add_api("example_03c_multimodal_image_fine_mode", payload)


def example_03d_multimodal_image_fast_mode():
    """
    Multimodal message with image in fast mode.

    - `mode="fast"`: Fast pipeline for quick processing
    - Combines text description with image_url for rapid extraction
    - Use case: When you need quick image processing without deep analysis
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
                        "text": "快速保存一下这张风景照片的记录。",
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "https://example.com/mountain_lake.jpg",
                            "detail": "high",
                        },
                    },
                ],
                "chat_time": "2025-11-24T10:23:00Z",
                "message_id": "mm-img-fast-1",
            }
        ],
        "mode": "fast",
        "async_mode": "async",
        "custom_tags": ["travel", "photo"],
        "info": {"source_type": "quick_image_save"},
    }
    call_add_api("example_03d_multimodal_image_fast_mode", payload)


# ===========================================================================
# 4. Pure input items without dialog context
# ===========================================================================


def example_04a_pure_text_input_items():
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
    call_add_api("example_04a_pure_text_input_items", payload)


def example_04b_pure_file_input_by_file_id():
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
                "type": "file",
                "file": {
                    "file_id": "file_uploaded_123",  # at least one of file_id/file_data needed
                    "filename": "document.pdf",  # optional
                },
            }
        ],
        "info": {"source_type": "file_ingestion"},
    }
    call_add_api("example_04b_pure_file_input_by_file_id", payload)


def example_04c_pure_file_input_by_file_data():
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
                "type": "file",
                "file": {
                    "file_data": "base64_encoded_file_content_here",  # at least one of file_id/file_data needed
                    "filename": "document.pdf",  # optional
                },
            }
        ],
        "info": {"source_type": "file_ingestion_base64"},
    }
    call_add_api("example_04c_pure_file_input_by_file_data", payload)


def example_04d_pure_file_input_by_oss_url():
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
                "type": "file",
                "file": {
                    "file_data": "oss_url",  # OSS URL instead of base64
                    "filename": "document.pdf",
                },
            }
        ],
        "info": {"source_type": "file_ingestion_oss"},
    }
    call_add_api("example_04d_pure_file_input_by_oss_url", payload)


# ===========================================================================
# 5. Deprecated fields: mem_cube_id, memory_content, doc_path, source
# ===========================================================================


def example_05_deprecated_memory_content_and_doc_path():
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
    call_add_api("example_05_deprecated_memory_content_and_doc_path", payload)


# ===========================================================================
# 6. Feedback and chat_history examples
# ===========================================================================


def example_06a_feedback_add():
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
    call_add_api("example_06a_feedback_add", payload)


def example_06b_family_travel_conversation():
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
    call_add_api("example_06b_family_travel_conversation", payload)


def example_06c_add_with_chat_history():
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
    call_add_api("example_06c_add_with_chat_history", payload)


# ===========================================================================
# 7. Search and Chat examples
# ===========================================================================


def example_07a_search_memories():
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
    print("[*] Example: 07a_search_memories")
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


def example_07b_chat_complete():
    """
    Chat completion using `APIChatCompleteRequest`.

    - Sends a chat query to the system.
    - System retrieves relevant memories and generates a response.
    - please make sure ENABLE_CHAT_API=true in .env or environment variables
    - and set up CHAT_MODEL_LIST in .env or environment variables properly with api keys and stuff.
    """
    # 1. First, add some relevant memory so the chat has context
    print("[*] Setting up context for chat...")
    setup_payload = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "messages": [
            {
                "role": "user",
                "content": "I prefer quiet hotels with good wifi.",
                "chat_time": "2025-01-01 10:00:00",
            },
            {
                "role": "assistant",
                "content": "Noted. Quiet environment and good wifi are your preferences.",
                "chat_time": "2025-01-01 10:00:10",
            },
        ],
        # Use sync mode to ensure memory is available immediately for the chat
        "async_mode": "sync",
    }
    call_add_api("setup_memory_for_chat", setup_payload)

    # 2. Interactive chat loop
    print("=" * 80)
    print("[*] Starting Interactive Chat (type 'exit' or 'quit' to stop)")
    print("=" * 80)

    while True:
        try:
            # Use input() to get user query from command line, example: "Where can I stay for a week?"
            query = input("\nUser: ").strip()

            # Check for exit commands
            if query.lower() in ["exit", "quit"]:
                print("Exiting chat...")
                break

            # Skip empty inputs
            if not query:
                continue

            payload = {
                "user_id": USER_ID,
                "query": query,
                "readable_cube_ids": [MEM_CUBE_ID],
                "writable_cube_ids": [MEM_CUBE_ID],
                "mode": "fast",
                "top_k": 5,
                "add_message_on_answer": True,
                "session_id": SESSION_ID,
            }

            resp = requests.post(
                f"{BASE_URL}/chat/complete", headers=HEADERS, data=json.dumps(payload), timeout=60
            )

            if resp.status_code == 200:
                try:
                    data = resp.json()
                    answer = data.get("data", {}).get("response", "")
                    print(f"Assistant: {answer}")
                except Exception as e:
                    print(f"Error parsing response: {e}")
                    print(resp.text)
            else:
                print(f"Error: {resp.status_code}")
                print(resp.text)

        except KeyboardInterrupt:
            print("\nExiting chat...")
            break
        except Exception as e:
            print(f"- Request failed with exception: {e!r}")

    print("=" * 80)
    print()


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    # You can comment out some examples if you do not want to run all of them.
    example_01a_string_message_minimal()
    example_01b_standard_chat_triplet()
    example_01c_sync_fast_minimal()
    example_01d_sync_fine_detailed()
    example_02a_assistant_with_tool_calls()
    example_02b_tool_message_with_result()
    example_03a_multimodal_text_and_image()
    example_03b_multimodal_text_and_file()
    example_03c_multimodal_image_fine_mode()
    example_03d_multimodal_image_fast_mode()
    example_04a_pure_text_input_items()
    example_04b_pure_file_input_by_file_id()
    example_04c_pure_file_input_by_file_data()
    example_04d_pure_file_input_by_oss_url()
    example_05_deprecated_memory_content_and_doc_path()
    example_06a_feedback_add()
    example_06b_family_travel_conversation()
    example_06c_add_with_chat_history()
    example_07a_search_memories()
    example_07b_chat_complete()
