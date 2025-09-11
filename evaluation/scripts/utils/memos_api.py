import json
import os
import requests
from dotenv import load_dotenv

load_dotenv()

memos_key = os.getenv("MEMOS_KEY")
memos_url = os.getenv("MEMOS_URL")


class MemOSAPI:
    def __init__(self, base_url: str = memos_url, memos_key: str = memos_key):
        self.base_url = base_url
        self.headers = {"Content-Type": "application/json", "Authorization": memos_key}

    def add(self, messages: list[dict], user_id: str | None = None, conv_id: str | None = None):
        """Create memories."""

        url = f"{self.base_url}/add/message"
        payload = json.dumps({"messages": messages, "userId": user_id, "conversationId": conv_id})
        response = requests.request("POST", url, data=payload, headers=self.headers)
        return response.text

    def search(self, query: str, user_id: str | None = None, conv_id: str | None = '', top_k: int = 10):
        """Search memories."""
        url = f"{self.base_url}/search/memory"
        payload = json.dumps(
            {
                "query": query,
                "userId": user_id,
                "conversationId": conv_id,
                "memoryLimitNumber": top_k
            }
        )

        response = requests.request("POST", url, data=payload, headers=self.headers)
        if response.status_code != 200:
            response.raise_for_status()
        else:
            return json.loads(response.text)["data"]


if __name__ == "__main__":
    client = MemOSAPI()
    user_id = 'eval_test'
    conv_id = 'eval_test_benchmark1_conv1'
    messages = [
            {"role": "user", "content": "杭州西湖有什么好玩的"},
            {"role": "assistant", "content": "杭州西湖有好多松鼠，还有断桥"}
        ]

    memories = client.search("我最近有什么记忆", user_id=user_id, top_k=6)
    response = client.add(messages, user_id, conv_id)
    memories = client.search("我最近有什么记忆", user_id=user_id, top_k=6)




