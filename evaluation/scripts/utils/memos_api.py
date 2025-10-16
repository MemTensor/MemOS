import json
import os
import traceback

import requests
from dotenv import load_dotenv

load_dotenv()

memos_key = os.getenv("MEMOS_KEY")
memos_url = 'http://127.0.0.1:8001'


class MemOSAPI:
    def __init__(self, base_url: str = memos_url, memos_key: str = memos_key):
        self.base_url = base_url
        self.headers = {"Content-Type": "application/json", "Authorization": memos_key}

    def add(self, messages: list[dict], user_id: str | None = None, conv_id: str | None = None):
        """Create memories."""
        retry = 0
        while retry < 10:
            try:
                url = f"{self.base_url}/product/add"
                payload = json.dumps(
                    {"messages": messages, "mem_cube_id": user_id, "user_id": user_id, "session_id": conv_id}
                )
                response = requests.request("POST", url, data=payload, headers=self.headers)
                assert response.status_code == 200, response.text
                assert json.loads(response.text)["message"] == 'Memory added successfully', response.text
                return response.text
            except Exception as e:
                print(f"call memos api add failed {e} retry time {retry}")
                # traceback.print_exc()
                retry += 1
        assert retry != 10, "add memory failed"

    def search(
        self, query: str, user_id: str | None = None, conv_id: str | None = "", top_k: int = 10
    ):
        """Search memories."""
        retry = 0
        while retry < 10:
            try:
                url = f"{self.base_url}/product/search"
                payload = json.dumps(
                    {
                        "query": query,
                        "mem_cube_id": user_id,
                        "session_id": conv_id,
                        "top_k": top_k,
                    },
                    ensure_ascii=False,
                )

                response = requests.request("POST", url, data=payload, headers=self.headers)
                assert response.status_code == 200, response.text
                assert json.loads(response.text)["message"] == "Search completed successfully", response.text
                return json.loads(response.text)["data"]
            except Exception as e:
                print(f"call memos api search failed {e} retry time {retry}")
                # traceback.print_exc()
                retry += 1
        assert retry != 10, "search memory failed"


if __name__ == "__main__":
    client = MemOSAPI()
    user_id = "eval_test"
    conv_id = "eval_test_benchmark1_conv1"
    messages = [
        {"role": "user", "content": "杭州西湖有什么好玩的"},
        {"role": "assistant", "content": "杭州西湖有好多松鼠，还有断桥"},
    ]

    memories = client.search("我最近有什么记忆", user_id=user_id, top_k=6)
    response = client.add(messages, user_id, conv_id)
    memories = client.search("我最近有什么记忆", user_id=user_id, top_k=6)
