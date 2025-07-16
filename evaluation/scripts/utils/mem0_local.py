from typing import Any, Dict, Optional

import requests


class Mem0Client:
    def __init__(self, base_url: str = "http://localhost:8000"):
        self.base_url = base_url

    def add(self, messages: list[Dict], timestamp: Optional[str] = None, user_id: Optional[str] = None, agent_id: Optional[str] = None, run_id: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None):
        """Create memories."""
        url = f"{self.base_url}/memories"

        if metadata is None:
            metadata = {}

        if user_id is None and agent_id is None and run_id is None:
            raise ValueError(
                "At least one of user_id, agent_id, or run_id must be provided.")

        if user_id:
            metadata["user_id"] = user_id
        if agent_id:
            metadata["agent_id"] = agent_id
        if run_id:
            metadata["run_id"] = run_id

        metadata["timestamp"] = timestamp

        data = {
            "messages": messages,
            "user_id": user_id,
            "agent_id": agent_id,
            "run_id": run_id,
            "metadata": metadata
        }

        response = requests.post(url, json=data)
        response.raise_for_status()
        return response.json()

    def search(self, query: str, user_id: Optional[str] = None, agent_id: Optional[str] = None, run_id: Optional[str] = None, filters: Optional[Dict[str, Any]] = None, top_k: int = 10):
        """Search memories."""
        url = f"{self.base_url}/search"

        if filters is None:
            filters = {}

        data = {
            "query": query,
            "user_id": user_id,
            "agent_id": agent_id,
            "run_id": run_id,
            "filters": filters,
        }

        response = requests.post(url, json=data)
        response.raise_for_status()

        results = response.json().get('results', [])
        top_k_results = results[:top_k] if len(results) > top_k else results

        relations = response.json().get('relations', [])
        top_k_relations = relations[:top_k] if len(
            relations) > top_k else relations

        return {
            "results": top_k_results,
            "relations": top_k_relations
        }

    def get_all(self, user_id: Optional[str] = None, agent_id: Optional[str] = None, run_id: Optional[str] = None):
        """Retrieve all memories."""
        url = f"{self.base_url}/memories"

        params = {}
        if user_id:
            params['user_id'] = user_id
        if agent_id:
            params['agent_id'] = agent_id
        if run_id:
            params['run_id'] = run_id

        response = requests.get(url, params=params)
        response.raise_for_status()
        return response.json()

    def get(self, memory_id: str):
        """Retrieve a specific memory by ID."""
        url = f"{self.base_url}/memories/{memory_id}"

        response = requests.get(url)
        response.raise_for_status()
        return response.json()

    def delete(self, memory_id: str):
        """Delete a specific memory by ID."""
        url = f"{self.base_url}/memories/{memory_id}"

        response = requests.delete(url)
        response.raise_for_status()
        return response.json()

    def delete_all(self, user_id: Optional[str] = None, agent_id: Optional[str] = None, run_id: Optional[str] = None):
        """Delete all memories for a user, agent, or run."""
        url = f"{self.base_url}/memories"

        params = {}
        if user_id:
            params['user_id'] = user_id
        if agent_id:
            params['agent_id'] = agent_id
        if run_id:
            params['run_id'] = run_id

        response = requests.delete(url, params=params)
        response.raise_for_status()
        return response.json()

    def reset(self):
        """Reset the memory store."""
        url = f"{self.base_url}/reset"

        response = requests.post(url)
        response.raise_for_status()
        return response.json()


if __name__ == "__main__":
    client = Mem0Client(base_url="http://localhost:9999")

    # Example usage
    print("Adding memories...")
    add_result_a = client.add(messages=[
                              {"role": "user", "content": "I like drinking coffee in the morning"}], user_id="alice")
    print(add_result_a)

    add_result_b = client.add(messages=[
                              {"role": "user", "content": "I enjoy reading books in the evening"}], user_id="alice")
    print(add_result_b)

    print("\nSearching memories...")
    search_result = client.search(
        query="When did Melanie paint a sunrise?", user_id="alice", top_k=10)
    print(search_result)
    print(len(search_result.get('results', [])))

    print("\nRetrieving all memories...")
    all_memories = client.get_all(user_id="alice")
    # print(all_memories)
    print(len(all_memories.get('results', [])))

    print("\nRetrieving a specific memory...")
    if all_memories and 'results' in all_memories and len(all_memories['results']) > 0:
        memory_id = all_memories['results'][0]['id']
        specific_memory = client.get(memory_id)
        print(specific_memory)

    print("\nDeleting a specific memory...")
    if all_memories and 'results' in all_memories and len(all_memories['results']) > 0:
        memory_id = all_memories['results'][0]['id']
        delete_result = client.delete(memory_id)
        print(delete_result)

    print("\nDeleting all memories for user 'alice'...")
    delete_all_result = client.delete_all(user_id="alice")
    print(delete_all_result)

    print("\nResetting the memory store...")
    reset_result = client.reset()
    print(reset_result)
