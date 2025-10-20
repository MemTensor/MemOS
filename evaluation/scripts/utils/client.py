import json
import os
import sys
import time
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
            self.client.graph.search(query=query, group_id=user_id, scope="edges", reranker="cross_encoder",
                                     limit=top_k))

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

    def add(self, messages, user_id):
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
            max_token_size=top_k * 100,
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
        url = f"{self.memos_url}/product/add"
        payload = json.dumps({"messages": messages, "user_id": user_id,
                              "mem_cube_id": user_id, "conversation_id": conv_id})
        response = requests.request("POST", url, data=payload, headers=self.headers)
        assert response.status_code == 200, response.text
        assert json.loads(response.text)["message"] == 'Memory added successfully', response.text
        return response.text

    def search(self, query, user_id, top_k):
        """Search memories."""
        url = f"{self.memos_url}/product/search"
        payload = json.dumps(
            {"query": query, "user_id": user_id, "mem_cube_id": user_id,
             "conversation_id": "", "top_k": top_k, }, ensure_ascii=False)
        response = requests.request("POST", url, data=payload, headers=self.headers)
        assert response.status_code == 200, response.text
        assert json.loads(response.text)["message"] == "Search completed successfully", response.text
        return json.loads(response.text)["data"]


class supermemory_client:
    def __init__(self):
        from supermemory import Supermemory
        self.client = Supermemory(api_key=os.getenv("SUPERMEMORY_API_KEY"))

    def add(self, messages, user_id):
        content = '\n'.join([f"{msg['chat_time']} {msg['role']}: {msg['content']}" for msg in messages])
        max_retries = 5
        for attempt in range(max_retries):
            try:
                self.client.memories.add(content=content, container_tag=user_id)
                break
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)  # 指数退避
                else:
                    raise e

    def search(self, query, user_id, top_k):
        max_retries = 10
        for attempt in range(max_retries):
            try:
                results = self.client.search.memories(q=query, container_tag=user_id, threshold=0.2,
                                                      rerank=True, rewrite_query=True, limit=top_k)
                context = '\n\n'.join([r.memory for r in results.results])
                return context
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)  # 指数退避
                else:
                    raise e


class memu_client:
    def __init__(self):
        from memu import MemuClient
        self.memu_client = MemuClient(base_url="https://api.memu.so", api_key=os.getenv("MEMU_API_KEY"))
        self.agent_id = "assistant_001"

    def add(self, messages, user_id, iso_date):
        try:
            response = self.memu_client.memorize_conversation(
                conversation=messages,
                user_id=user_id,
                user_name=user_id,
                agent_id=self.agent_id,
                agent_name=self.agent_id,
                session_date=iso_date
            )
            self.wait_for_completion(response.task_id)
        except Exception as error:
            print('❌ Error saving conversation:', error)

    def search(self, query, user_id, top_k):
        user_memories = self.memu_client.retrieve_related_memory_items(
            user_id=user_id, agent_id=self.agent_id,
            query=query, top_k=top_k, min_similarity=0.1)
        res = [m.memory.content for m in user_memories.related_memories]
        return res

    def wait_for_completion(self, task_id):
        while True:
            status = self.memu_client.get_task_status(task_id)
            if status.status in ['SUCCESS', 'FAILURE', 'REVOKED']:
                break
            time.sleep(2)


if __name__ == "__main__":
    messages = [{"role": "user", "content": "杭州西湖有什么好玩的"},
                {"role": "assistant", "content": "杭州西湖有好多松鼠，还有断桥"}]
    user_id = 'test_user'
    iso_date = "2023-05-01T00:00:00.000Z"
    query = "杭州西湖有什么"
    top_k = 5

    # # memu
    # memu_client = memu_client()
    # memu_client.add(messages, user_id, iso_date)
    # res = memu_client.search(query, user_id, top_k)

    # supermemory
    supermemory_client = supermemory_client()
    supermemory_client.delete('locomo_exp_user_5_speaker_b_default')
