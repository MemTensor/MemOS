import json

import requests


class MemOSAPI:
    def __init__(self, base_url: str = "http://localhost:8000"):
        self.base_url = base_url
        self.headers = {"Content-Type": "application/json"}

    def user_register(self, user_id: str):
        """Register a user."""
        url = f"{self.base_url}/users/register"
        payload = json.dumps({"user_id": user_id})
        response = requests.request("POST", url, data=payload, headers=self.headers)
        return response.text

    def add(self, messages: list[dict], user_id: str | None = None):
        """Create memories."""
        register_res = json.loads(self.user_register(user_id))
        cube_id = register_res["data"]["mem_cube_id"]
        url = f"{self.base_url}/add"
        payload = json.dumps({"messages": messages, "user_id": user_id, "mem_cube_id": cube_id})

        response = requests.request("POST", url, data=payload, headers=self.headers)
        return response.text

    def search(self, query: str, user_id: str | None = None, top_k: int = 10):
        """Search memories."""
        url = f"{self.base_url}/search"
        payload = json.dumps(
            {
                "query": query,
                "user_id": user_id,
            }
        )

        response = requests.request("POST", url, data=payload, headers=self.headers)
        if response.status_code != 200:
            response.raise_for_status()
        else:
            result = json.loads(response.text)["data"]["text_mem"][0]["memories"]
            text_memories = [item["memory"] for item in result][:top_k]
            return text_memories


if __name__ == "__main__":
    client = MemOSAPI(base_url="http://localhost:8000")
    # Example usage
    try:
        messages = [
            {
                "role": "user",
                "content": "I went to the store and bought a red apple.",
                "chat_time": "2023-10-01T12:00:00Z",
            }
        ]
        add_response = client.add(messages, user_id="user789")
        print("Add memory response:", add_response)
        search_response = client.search("red apple", user_id="user789", top_k=1)
        print("Search memory response:", search_response)
    except requests.RequestException as e:
        print("An error occurred:", e)
