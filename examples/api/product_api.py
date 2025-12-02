#!/usr/bin/env python3
"""
Simulate full MemOS Product API workflow:
1. Register user
2. Add memory
3. Search memory
4. Chat (stream)
"""

import json

import requests


BASE_URL = "http://0.0.0.0:8001/product"
HEADERS = {"Content-Type": "application/json"}

index = "24"
USER_ID = f"memos_user_id_{index}"
USER_NAME = f"memos_user_alice_{index}"
MEM_CUBE_ID = f"memos_cube_id_{index}"
SESSION_ID = f"memos_session_id_{index}"
SESSION_ID2 = f"memos_session_id_{index}_s2"


def register_user():
    url = f"{BASE_URL}/users/register"
    data = {
        "user_id": USER_ID,
        "user_name": USER_NAME,
        "interests": "memory,retrieval,test",
        "mem_cube_id": MEM_CUBE_ID,
    }
    print(f"[*] Registering user {USER_ID} ...")
    resp = requests.post(url, headers=HEADERS, data=json.dumps(data), timeout=30)
    print(resp.status_code, resp.text)
    return resp.json()


def add_memory():
    url = f"{BASE_URL}/add"
    data = {
        "user_id": USER_ID,
        "memory_content": "今天我在测试 MemOS 的记忆添加与检索流程。",
        "messages": [{"role": "user", "content": "我今天在做系统测试"}],
        "doc_path": None,
        "mem_cube_id": MEM_CUBE_ID,
        "source": "test_script",
        "user_profile": False,
        "session_id": SESSION_ID,
    }
    print("[*] Adding memory ...")
    resp = requests.post(url, headers=HEADERS, data=json.dumps(data), timeout=30)
    print(resp.status_code, resp.text)
    return resp.json()


def search_memory(query="系统测试"):
    url = f"{BASE_URL}/search"
    data = {
        "user_id": USER_ID,
        "query": query,
        "mem_cube_id": MEM_CUBE_ID,
        "top_k": 5,
        "session_id": SESSION_ID,
    }
    print("[*] Searching memory ...")
    resp = requests.post(url, headers=HEADERS, data=json.dumps(data), timeout=30)
    print(resp.status_code, resp.text)
    return resp.json()


def chat_stream(query: str, session_id: str, history: list | None = None):
    url = f"{BASE_URL}/chat"
    data = {
        "user_id": USER_ID,
        "query": query,
        "mem_cube_id": MEM_CUBE_ID,
        "history": history,
        "internet_search": False,
        "moscube": False,
        "session_id": session_id,
    }

    print("[*] Starting streaming chat ...")

    with requests.post(url, headers=HEADERS, data=json.dumps(data), stream=True) as resp:
        for raw_line in resp.iter_lines():
            if not raw_line:
                continue
            line = raw_line.decode("utf-8", errors="ignore")

            payload = line.removeprefix("data: ").strip()
            if payload == "[DONE]":
                print("[done]")
                break

            try:
                msg = json.loads(payload)
                msg_type = msg.get("type")
                msg_data = msg.get("data") or msg.get("content")

                if msg_type == "text":
                    print(msg_data, end="", flush=True)
                elif msg_type == "reference":
                    print(f"\n[参考记忆] {msg_data}")
                elif msg_type == "status":
                    pass
                elif msg_type == "suggestion":
                    print(f"\n[建议] {msg_data}")
                elif msg_type == "end":
                    print("\n[✅ Chat End]")
                else:
                    print(f"\n[{msg_type}] {msg_data}")
            except Exception:
                try:
                    print(payload.encode("latin-1").decode("utf-8"), end="")
                except Exception:
                    print(payload)


def feedback_memory(feedback_content: str, history: list | None = None):
    url = f"{BASE_URL}/feedback"
    data = {
        "user_id": USER_ID,
        "writable_cube_ids": [MEM_CUBE_ID],
        "history": history,
        "feedback_content": feedback_content,
        "async_mode": "sync",
        "corrected_answer": "false",
    }

    print("[*] Feedbacking memory ...")
    resp = requests.post(url, headers=HEADERS, data=json.dumps(data), timeout=30)
    print(resp.status_code, resp.text)
    return resp.json()


if __name__ == "__main__":
    print("===== STEP 1: Register User =====")
    register_user()

    print("\n===== STEP 2: Add Memory =====")
    add_memory()

    print("\n===== STEP 3: Search Memory =====")
    search_memory()

    print("\n===== STEP 4: Stream Chat =====")
    chat_stream("我很开心，我今天吃了好吃的拉面", SESSION_ID, history=[])
    chat_stream(
        "我刚和你说什么",
        SESSION_ID,
        history=[
            {"role": "user", "content": "我很开心，我今天吃了好吃的拉面"},
            {"role": "assistant", "content": "🉑"},
        ],
    )

    print("\n===== STEP 5: Stream Chat =====")
    chat_stream("我刚和你说什么了呢", SESSION_ID2, history=[])

    print("\n===== STEP 6: Feedback Memory =====")
    feedback_memory(
        feedback_content="错啦，我今天没有吃拉面",
        history=[
            {"role": "user", "content": "我刚和你说什么了呢"},
            {"role": "assistant", "content": "你今天吃了好吃的拉面"},
        ],
    )
