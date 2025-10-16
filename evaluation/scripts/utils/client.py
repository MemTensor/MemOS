import json
import os
import sys
from datetime import datetime
from dotenv import load_dotenv
import requests

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()


class zep_client:
    def __init__(self):
        from zep_cloud.client import Zep
        api_key = os.getenv("ZEP_API_KEY")
        self.client = Zep(api_key=api_key)

    def add(self, messages, user_id, conv_id, timestamp):
        iso_date = datetime.fromtimestamp(timestamp).isoformat()
        for msg in messages:
            self.client.graph.add(
                data=msg.get("role") + ": " + msg.get("content"),
                type="message", created_at=iso_date, group_id=user_id)

    def search(self, query, user_id, top_k):
        search_results = (
            self.client.graph.search(query=query, group_id=user_id, scope="nodes", reranker="rrf", limit=top_k),
            self.client.graph.search(query=query, group_id=user_id, scope="edges", reranker="cross_encoder", limit=top_k)
        )

        nodes = search_results[0].nodes
        edges = search_results[1].edges
        return nodes, edges


class mem0_client:
    def __init__(self, enable_graph=False):
        from mem0 import MemoryClient
        self.client = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
        self.enable_graph = enable_graph

    def add(self, messages, user_id, timestamp):
        if self.enable_graph:
            self.client.add(messages=messages, timestamp=timestamp, user_id=user_id,
                            output_format="v1.1", version="v2", enable_graph=True)
        else:
            self.client.add(messages=messages, timestamp=timestamp, user_id=user_id, version="v2")

    def search(self, query, user_id, top_k):
        if self.enable_graph:
            res = self.client.search(query=query, top_k=top_k, user_id=user_id, output_format="v1.1", version="v2",
                                     enable_graph=True, filters={"AND": [{"user_id": f"{user_id}"}, {"run_id": "*"}]})
        else:
            res = self.client.search(query=query, top_k=top_k, user_id=user_id, output_format="v1.1", version="v2",
                                     filters={"AND": [{"user_id": f"{user_id}"}, {"run_id": "*"}]})
        return res


class memobase_client:
    def __init__(self):
        from memobase import MemoBaseClient
        self.client = MemoBaseClient(project_url=os.getenv("MEMOBASE_PROJECT_URL"),
                                     api_key=os.getenv("MEMOBASE_API_KEY"))

    def add(self, messages, user_id, conv_id, timestamp):
        from memobase import ChatBlob
        """
        user_id: memobase user_id
        messages = [{"role": "assistant", "content": data, "created_at": iso_date}]
        """
        user = self.client.get_user(user_id, no_get=True)
        user.insert(ChatBlob(messages=messages), sync=True)

    def search(self, query, user_id, top_k):
        user = self.client.get_user(user_id, no_get=True)
        memories = user.context(
            max_token_size=top_k*100,
            chats=[{"role": "user", "content": query}],
            event_similarity_threshold=0.2,
            fill_window_with_events=True,
        )
        return memories


class memos_api_client:
    def __init__(self):
        self.memos_url = os.getenv("MEMOS_URL")
        self.headers = {"Content-Type": "application/json", "Authorization": os.getenv("MEMOS_KEY")}

    def add(self, messages, user_id, conv_id):
        url = f"{self.memos_url}/add"
        payload = json.dumps({"messages": messages, "user_id": user_id, "conversation_id": conv_id})
        response = requests.request("POST", url, data=payload, headers=self.headers)
        assert response.status_code == 200, response.text
        assert json.loads(response.text)["message"] == 'Memory added successfully', response.text
        return response.text

    def search(self, query, user_id, top_k):
        """Search memories."""
        url = f"{self.memos_url}/search"
        payload = json.dumps(
            {"query": query, "user_id": user_id, "conversation_id": "", "top_k": top_k, }, ensure_ascii=False)
        response = requests.request("POST", url, data=payload, headers=self.headers)
        assert response.status_code == 200, response.text
        assert json.loads(response.text)["message"] == "Search completed successfully", response.text
        return json.loads(response.text)["data"]


if __name__ == "__main__":
    pass
    # # zep
    # # Example usage of the Zep client
    # zep = zep_client()
    # print("Zep client initialized successfully.")
    #
    # # Example of adding a session and a message to Zep memory
    # user_id = "user123"
    # session_id = "session123"
    #
    # zep.memory.add_session(
    #     session_id=session_id,
    #     user_id=user_id,
    # )
    # from zep_cloud.types import Message
    #
    # messages = [
    #     Message(
    #         role="Jane",
    #         role_type="user",
    #         content="Who was Octavia Butler?",
    #     )
    # ]
    # new_episode = zep.memory.add(
    #     session_id=session_id,
    #     messages=messages,
    # )
    # print("New episode added:", new_episode)
    #
    # # Example of searching for nodes and edges in Zep memory
    # nodes_result = zep.graph.search(
    #     query="Octavia Butler",
    #     user_id="user123",
    #     scope="nodes",
    #     reranker="rrf",
    #     limit=10,
    # ).nodes
    #
    # edges_result = zep.graph.search(
    #     query="Octavia Butler",
    #     user_id="user123",
    #     scope="edges",
    #     reranker="cross_encoder",
    #     limit=10,
    # ).edges
    #
    # print("Nodes found:", nodes_result)
    # print("Edges found:", edges_result)
    #
    # # Example usage of the Mem0 client
    # mem0 = mem0_client(mode="local")
    # print("Mem0 client initialized successfully.")
    # print("Adding memories...")
    # result = mem0.add(
    #     messages=[
    #         {"role": "user", "content": "I like drinking coffee in the morning"},
    #         {"role": "user", "content": "I enjoy reading books at night"},
    #     ],
    #     user_id="alice",
    # )
    # print("Memory added:", result)
    #
    # print("Searching memories...")
    # search_result = mem0.search(query="coffee", user_id="alice", top_k=2)
    # print("Search results:", search_result)
    #
    # # Example usage of the Memos client
    # memos_a = memos_client(
    #     mode="local",
    #     db_name="session333",
    #     user_id="dlice",
    #     top_k=20,
    #     mem_cube_path="./mem_cube_a",
    #     mem_cube_config_path="configs/lme_mem_cube_config.json",
    #     mem_os_config_path="configs/mos_memos_config.json",
    # )
    # print("Memos a client initialized successfully.")
    # memos_b = memos_client(
    #     mode="local",
    #     db_name="session444",
    #     user_id="alice",
    #     top_k=20,
    #     mem_cube_path="./mem_cube_b",
    #     mem_cube_config_path="configs/lme_mem_cube_config.json",
    #     mem_os_config_path="configs/mos_memos_config.json",
    # )
    # print("Memos b client initialized successfully.")
    #
    # # Example of adding memories in Memos
    # memos_a.add(
    #     messages=[
    #         {"role": "user", "content": "I like drinking coffee in the morning"},
    #         {"role": "user", "content": "I enjoy reading books at night"},
    #     ],
    #     user_id="dlice",
    # )
    # memos_b.add(
    #     messages=[
    #         {"role": "user", "content": "I like playing football in the evening"},
    #         {"role": "user", "content": "I enjoy watching movies at night"},
    #     ],
    #     user_id="alice",
    # )
    #
    # # Example of searching memories in Memos
    # search_result_a = memos_a.search(query="coffee", user_id="dlice")
    # filtered_search_result_a = filter_memory_data(search_result_a)["text_mem"][0]["memories"]
    # print("Search results in Memos A:", filtered_search_result_a)
    #
    # search_result_b = memos_b.search(query="football", user_id="alice")
    # filtered_search_result_b = filter_memory_data(search_result_b)["text_mem"][0]["memories"]
    # print("Search results in Memos B:", filtered_search_result_b)
    #
    # # Example usage of MemoBase client
    # client = memobase_client()
    # print("MemoBase client initialized successfully.")
    #
    # # Example of adding a user and retrieving user information
    # user_id = client.add_user()
    # user = client.get_user(user_id)
    #
    # # Example of adding a chat blob to the user
    # print(f"Adding chat blob for user {user_id}...")
    # b = ChatBlob(
    #     messages=[
    #         {"role": "user", "content": "Hi, I'm here again"},
    #         {"role": "assistant", "content": "Hi, Gus! How can I help you?"},
    #     ]
    # )
    # bid = user.insert(b)
    #
    # # Example of retrieving the context of the user
    # context = user.context()
    # print(context)
