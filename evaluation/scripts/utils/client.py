import json
import os
import sys

from dotenv import load_dotenv
from mem0 import MemoryClient
from zep_cloud.client import Zep
from zep_cloud.types import Message


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from utils.mem0_local import Mem0Client
from utils.memos_filters import filter_memory_data


load_dotenv()


def zep_client():
    """Initialize and return a Zep client instance."""
    api_key = os.getenv("ZEP_API_KEY")
    zep = Zep(api_key=api_key)

    return zep


def mem0_client(mode="local"):
    """Initialize and return a Mem0 client instance."""
    if mode == "local":
        base_url = "http://localhost:9999"
        mem0 = Mem0Client(base_url=base_url)
    elif mode == "api":
        mem0 = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
    else:
        raise ValueError("Invalid mode. Choose 'local' or 'cloud'.")

    return mem0


def memos_client(
    mode="local",
    db_name=None,
    user_id=None,
    top_k=20,
    mem_cube_path="./",
    mem_cube_config_path="configs/lme_mem_cube_config.json",
    mem_os_config_path="configs/mos_memos_config.json",
    addorsearch="add",
):
    """Initialize and return a Memos client instance."""
    if mode == "local":
        with open(mem_os_config_path) as f:
            mos_config_data = json.load(f)
        mos_config_data["top_k"] = top_k
        mos_config = MOSConfig(**mos_config_data)
        memos = MOS(mos_config)
        memos.create_user(user_id=user_id)

        if addorsearch == "add":
            with open(mem_cube_config_path) as f:
                mem_cube_config_data = json.load(f)
            mem_cube_config_data["user_id"] = user_id
            mem_cube_config_data["cube_id"] = user_id
            mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["db_name"] = (
                f"{db_name.replace('_', '')}"
            )
            mem_cube_config = GeneralMemCubeConfig.model_validate(mem_cube_config_data)
            mem_cube = GeneralMemCube(mem_cube_config)

        if not os.path.exists(mem_cube_path):
            mem_cube.dump(mem_cube_path)

        memos.register_mem_cube(
            mem_cube_name_or_path=mem_cube_path,
            mem_cube_id=user_id,
            user_id=user_id,
        )

    elif mode == "api":
        pass

    return memos


if __name__ == "__main__":
    # Example usage of the Zep client
    zep = zep_client()
    print("Zep client initialized successfully.")

    # Example of adding a session and a message to Zep memory
    user_id = "user123"
    session_id = "session123"

    zep.memory.add_session(
        session_id=session_id,
        user_id=user_id,
    )

    messages = [
        Message(
            role="Jane",
            role_type="user",
            content="Who was Octavia Butler?",
        )
    ]
    new_episode = zep.memory.add(
        session_id=session_id,
        messages=messages,
    )
    print("New episode added:", new_episode)

    # Example of searching for nodes and edges in Zep memory
    nodes_result = zep.graph.search(
        query="Octavia Butler",
        user_id="user123",
        scope="nodes",
        reranker="rrf",
        limit=10,
    ).nodes

    edges_result = zep.graph.search(
        query="Octavia Butler",
        user_id="user123",
        scope="edges",
        reranker="cross_encoder",
        limit=10,
    ).edges

    print("Nodes found:", nodes_result)
    print("Edges found:", edges_result)

    # Example usage of the Mem0 client
    mem0 = mem0_client(mode="local")
    print("Mem0 client initialized successfully.")
    print("Adding memories...")
    result = mem0.add(
        messages=[
            {"role": "user", "content": "I like drinking coffee in the morning"},
            {"role": "user", "content": "I enjoy reading books at night"},
        ],
        user_id="alice",
    )
    print("Memory added:", result)

    print("Searching memories...")
    search_result = mem0.search(query="coffee", user_id="alice", top_k=2)
    print("Search results:", search_result)

    # Example usage of the Memos client
    memos_a = memos_client(
        mode="local",
        db_name="session333",
        user_id="dlice",
        top_k=20,
        mem_cube_path="./mem_cube_a",
        mem_cube_config_path="configs/lme_mem_cube_config.json",
        mem_os_config_path="configs/mos_memos_config.json",
    )
    print("Memos a client initialized successfully.")
    memos_b = memos_client(
        mode="local",
        db_name="session444",
        user_id="alice",
        top_k=20,
        mem_cube_path="./mem_cube_b",
        mem_cube_config_path="configs/lme_mem_cube_config.json",
        mem_os_config_path="configs/mos_memos_config.json",
    )
    print("Memos b client initialized successfully.")

    # Example of adding memories in Memos
    memos_a.add(
        messages=[
            {"role": "user", "content": "I like drinking coffee in the morning"},
            {"role": "user", "content": "I enjoy reading books at night"},
        ],
        user_id="dlice",
    )
    memos_b.add(
        messages=[
            {"role": "user", "content": "I like playing football in the evening"},
            {"role": "user", "content": "I enjoy watching movies at night"},
        ],
        user_id="alice",
    )

    # Example of searching memories in Memos
    search_result_a = memos_a.search(query="coffee", user_id="dlice")
    filtered_search_result_a = filter_memory_data(search_result_a)["text_mem"][0]["memories"]
    print("Search results in Memos A:", filtered_search_result_a)

    search_result_b = memos_b.search(query="football", user_id="alice")
    filtered_search_result_b = filter_memory_data(search_result_b)["text_mem"][0]["memories"]
    print("Search results in Memos B:", filtered_search_result_b)
