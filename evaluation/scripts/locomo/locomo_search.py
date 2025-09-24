import os
import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)

import argparse
import json

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import time
import pandas as pd
from dotenv import load_dotenv
from tqdm import tqdm
from utils.memos_filters import filter_memory_data
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS


def get_client(frame: str, user_id: str | None = None, version: str = "default", top_k: int = 20):
    if frame == "zep":
        from zep_cloud.client import Zep
        zep = Zep(api_key=os.getenv("ZEP_API_KEY"), base_url="https://api.getzep.com/api/v2")
        return zep

    elif frame == "mem0" or frame == "mem0_graph":
        from mem0 import MemoryClient
        mem0 = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
        return mem0

    elif frame == "memos":
        mos_config_path = "configs/mos_memos_config.json"
        with open(mos_config_path) as f:
            mos_config_data = json.load(f)
        mos_config_data["top_k"] = top_k
        mos_config = MOSConfig(**mos_config_data)
        mos = MOS(mos_config)
        mos.create_user(user_id=user_id)

        storage_path = f"results/locomo/{frame}-{version}/storages/{user_id}"

        mos.register_mem_cube(
            mem_cube_name_or_path=storage_path,
            mem_cube_id=user_id,
            user_id=user_id,
        )

        return mos


TEMPLATE_ZEP = """
FACTS and ENTITIES represent relevant context to the current conversation.

# These are the most relevant facts for the conversation along with the datetime of the event that the fact refers to.
If a fact mentions something happening a week ago, then the datetime will be the date time of last week and not the datetime
of when the fact was stated.
Timestamps in memories represent the actual time the event occurred, not the time the event was mentioned in a message.

<FACTS>
{facts}
</FACTS>

# These are the most relevant entities
# ENTITY_NAME: entity summary
<ENTITIES>
{entities}
</ENTITIES>
"""

TEMPLATE_MEM0 = """Memories for user {speaker_1_user_id}:

    {speaker_1_memories}

    Memories for user {speaker_2_user_id}:

    {speaker_2_memories}
"""

TEMPLATE_MEM0_GRAPH = """Memories for user {speaker_1_user_id}:

    {speaker_1_memories}

    Relations for user {speaker_1_user_id}:

    {speaker_1_graph_memories}

    Memories for user {speaker_2_user_id}:

    {speaker_2_memories}

    Relations for user {speaker_2_user_id}:

    {speaker_2_graph_memories}
"""

TEMPLATE_MEMOS = """Memories for user {speaker_1}:

    {speaker_1_memories}

    Memories for user {speaker_2}:

    {speaker_2_memories}
"""

TEMPLATE_MEMOBASE = """Memories for user {speaker_1_user_id}:

    {speaker_1_memories}

    Memories for user {speaker_2_user_id}:

    {speaker_2_memories}
"""


def mem0_search(client, query, speaker_a_user_id, speaker_b_user_id, top_k=20):
    start = time()
    search_speaker_a_results = client.search(
        query=query,
        top_k=top_k,
        user_id=speaker_a_user_id,
        output_format="v1.1",
        version="v2",
        filters={"AND": [{"user_id": f"{speaker_a_user_id}"}, {"run_id": "*"}]},
    )
    search_speaker_b_results = client.search(
        query=query,
        top_k=top_k,
        user_id=speaker_b_user_id,
        output_format="v1.1",
        version="v2",
        filters={"AND": [{"user_id": f"{speaker_b_user_id}"}, {"run_id": "*"}]},
    )

    search_speaker_a_memory = [
        {
            "memory": memory["memory"],
            "timestamp": memory["created_at"],
            "score": round(memory["score"], 2),
        }
        for memory in search_speaker_a_results["results"]
    ]

    search_speaker_a_memory = [
        [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_a_memory]
    ]

    search_speaker_b_memory = [
        {
            "memory": memory["memory"],
            "timestamp": memory["created_at"],
            "score": round(memory["score"], 2),
        }
        for memory in search_speaker_b_results["results"]
    ]

    search_speaker_b_memory = [
        [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_b_memory]
    ]

    context = TEMPLATE_MEM0.format(
        speaker_1_user_id=speaker_a_user_id.split("_")[0],
        speaker_1_memories=json.dumps(search_speaker_a_memory, indent=4),
        speaker_2_user_id=speaker_b_user_id.split("_")[0],
        speaker_2_memories=json.dumps(search_speaker_b_memory, indent=4),
    )

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memos_search(client, query, conv_id, speaker_a, speaker_b, reversed_client=None):
    start = time()
    search_a_results = client.search(
        query=query,
        user_id=conv_id + "_speaker_a",
    )
    filtered_search_a_results = filter_memory_data(search_a_results)["text_mem"][0]["memories"]
    speaker_a_context = ""
    for item in filtered_search_a_results:
        speaker_a_context += f"{item['memory']}\n"

    search_b_results = reversed_client.search(
        query=query,
        user_id=conv_id + "_speaker_b",
    )
    filtered_search_b_results = filter_memory_data(search_b_results)["text_mem"][0]["memories"]
    speaker_b_context = ""
    for item in filtered_search_b_results:
        speaker_b_context += f"{item['memory']}\n"

    context = TEMPLATE_MEMOS.format(
        speaker_1=speaker_a,
        speaker_1_memories=speaker_a_context,
        speaker_2=speaker_b,
        speaker_2_memories=speaker_b_context,
    )

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memos_api_search(
    client, query, conv_id, speaker_a, speaker_b, top_k, version
):
    start = time()
    search_a_results = client.search(
        query=query, user_id=f"{conv_id}_speaker_a_{version}", top_k=top_k
    )
    speaker_a_context = ""
    for item in search_a_results['openmem_search_memory_detail']:
        speaker_a_context += f"{item['memory_value']}\n"

    search_b_results = client.search(
        query=query, user_id=f"{conv_id}_speaker_b_{version}", top_k=top_k
    )
    speaker_b_context = ""
    for item in search_b_results['openmem_search_memory_detail']:
        speaker_b_context += f"{item['memory_value']}\n"

    context = TEMPLATE_MEMOS.format(
        speaker_1=speaker_a,
        speaker_1_memories=speaker_a_context,
        speaker_2=speaker_b,
        speaker_2_memories=speaker_b_context,
    )

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def mem0_graph_search(client, query, speaker_a_user_id, speaker_b_user_id, top_k=20):
    start = time()
    search_speaker_a_results = client.search(
        query=query,
        top_k=top_k,
        user_id=speaker_a_user_id,
        output_format="v1.1",
        version="v2",
        enable_graph=True,
        filters={"AND": [{"user_id": f"{speaker_a_user_id}"}, {"run_id": "*"}]},
    )
    search_speaker_b_results = client.search(
        query=query,
        top_k=top_k,
        user_id=speaker_b_user_id,
        output_format="v1.1",
        version="v2",
        enable_graph=True,
        filters={"AND": [{"user_id": f"{speaker_b_user_id}"}, {"run_id": "*"}]},
    )

    search_speaker_a_memory = [
        {
            "memory": memory["memory"],
            "timestamp": memory["created_at"],
            "score": round(memory["score"], 2),
        }
        for memory in search_speaker_a_results["results"]
    ]

    search_speaker_a_memory = [
        [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_a_memory]
    ]

    search_speaker_b_memory = [
        {
            "memory": memory["memory"],
            "timestamp": memory["created_at"],
            "score": round(memory["score"], 2),
        }
        for memory in search_speaker_b_results["results"]
    ]

    search_speaker_b_memory = [
        [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_b_memory]
    ]

    search_speaker_a_graph = [
        {
            "source": relation["source"],
            "relationship": relation["relationship"],
            "target": relation["target"],
        }
        for relation in search_speaker_a_results["relations"]
    ]

    search_speaker_b_graph = [
        {
            "source": relation["source"],
            "relationship": relation["relationship"],
            "target": relation["target"],
        }
        for relation in search_speaker_b_results["relations"]
    ]
    context = TEMPLATE_MEM0_GRAPH.format(
        speaker_1_user_id=speaker_a_user_id.split("_")[0],
        speaker_1_memories=json.dumps(search_speaker_a_memory, indent=4),
        speaker_1_graph_memories=json.dumps(search_speaker_a_graph, indent=4),
        speaker_2_user_id=speaker_b_user_id.split("_")[0],
        speaker_2_memories=json.dumps(search_speaker_b_memory, indent=4),
        speaker_2_graph_memories=json.dumps(search_speaker_b_graph, indent=4),
    )
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def zep_search(client, query, group_id, top_k=20):
    start = time()
    nodes_result = client.graph.search(
        query=query,
        group_id=group_id,
        scope="nodes",
        reranker="rrf",
        limit=top_k,
    )
    edges_result = client.graph.search(
        query=query,
        group_id=group_id,
        scope="edges",
        reranker="cross_encoder",
        limit=top_k,
    )

    nodes = nodes_result.nodes
    edges = edges_result.edges

    facts = [f"  - {edge.fact} (event_time: {edge.valid_at})" for edge in edges]
    entities = [f"  - {node.name}: {node.summary}" for node in nodes]
    context = TEMPLATE_ZEP.format(facts="\n".join(facts), entities="\n".join(entities))

    duration_ms = (time() - start) * 1000

    return context, duration_ms


def memobase_search(
    client, query, speaker_a, speaker_b, speaker_a_user_id, speaker_b_user_id, top_k=20
):
    from utils.memobase_utils import memobase_search_memory
    speaker_a_memories, t1 = memobase_search_memory(
        client, speaker_a_user_id, query, max_memory_context_size=top_k * 100
    )
    speaker_b_memories, t2 = memobase_search_memory(
        client, speaker_b_user_id, query, max_memory_context_size=top_k * 100
    )
    context = TEMPLATE_MEMOBASE.format(
        speaker_1_user_id=speaker_a,
        speaker_1_memories=speaker_a_memories,
        indent=4,
        speaker_2_user_id=speaker_b,
        speaker_2_memories=speaker_b_memories,
    )
    duration_ms = t1 + t2
    return context, duration_ms


def search_query(client, query, metadata, frame, version, reversed_client=None, top_k=20):
    conv_id = metadata.get("conv_id")
    speaker_a = metadata.get("speaker_a")
    speaker_b = metadata.get("speaker_b")
    speaker_a_user_id = metadata.get("speaker_a_user_id")
    speaker_b_user_id = metadata.get("speaker_b_user_id")

    if frame == "zep":
        context, duration_ms = zep_search(client, query, conv_id, top_k)
        # sleep(0.1)
    elif frame == "mem0":
        context, duration_ms = mem0_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k
        )
    elif frame == "mem0_graph":
        context, duration_ms = mem0_graph_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k
        )
    elif frame == "memos":
        context, duration_ms = memos_search(
            client, query, conv_id, speaker_a, speaker_b, reversed_client
        )
    elif frame == "memos-api":
        context, duration_ms = memos_api_search(
            client, query, conv_id, speaker_a, speaker_b, top_k, version
        )
    elif frame == "memobase":
        speaker_a_user_id = conv_id + "_speaker_a"
        speaker_b_user_id = conv_id + "_speaker_b"
        context, duration_ms = memobase_search(client, query, speaker_a, speaker_b, speaker_a_user_id, speaker_b_user_id, top_k)
    return context, duration_ms


def load_existing_results(frame, version, group_idx):
    result_path = (
        f"results/locomo/{frame}-{version}/tmp/{frame}_locomo_search_results_{group_idx}.json"
    )
    if os.path.exists(result_path):
        try:
            with open(result_path) as f:
                return json.load(f), True
        except Exception as e:
            print(f"Error loading existing results for group {group_idx}: {e}")
    return {}, False


def process_user(group_idx, locomo_df, frame, version, top_k=20, num_workers=1):
    search_results = defaultdict(list)
    qa_set = locomo_df["qa"].iloc[group_idx]
    conversation = locomo_df["conversation"].iloc[group_idx]
    speaker_a = conversation.get("speaker_a")
    speaker_b = conversation.get("speaker_b")
    speaker_a_user_id = f"{speaker_a}_{group_idx}"
    speaker_b_user_id = f"{speaker_b}_{group_idx}"
    conv_id = f"locomo_exp_user_{group_idx}"

    existing_results, loaded = load_existing_results(frame, version, group_idx)
    if loaded:
        print(f"Loaded existing results for group {group_idx}")
        return existing_results

    metadata = {
        "speaker_a": speaker_a,
        "speaker_b": speaker_b,
        "speaker_a_user_id": speaker_a_user_id,
        "speaker_b_user_id": speaker_b_user_id,
        "conv_idx": group_idx,
        "conv_id": conv_id,
    }

    reversed_client = None
    if frame == "memos":
        speaker_a_user_id = conv_id + "_speaker_a"
        speaker_b_user_id = conv_id + "_speaker_b"
        client = get_client(frame, speaker_a_user_id, version, top_k=top_k)
        reversed_client = get_client(frame, speaker_b_user_id, version, top_k=top_k)
    elif frame == "memos-api":
        from utils.memos_api import MemOSAPI
        client = MemOSAPI()
    elif frame == "memobase":
        from utils.client import memobase_client
        client = memobase_client()
    else:
        client = get_client(frame, conv_id, version)

    def process_qa(qa):
        query = qa.get("question")
        if qa.get("category") == 5:
            return None
        context, duration_ms = search_query(
            client, query, metadata, frame, version, reversed_client=reversed_client, top_k=top_k
        )

        if not context:
            print(f"No context found for query: {query}")
            context = ""
        return {"query": query, "context": context, "duration_ms": duration_ms}

    futures = []
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        for qa in qa_set:
            futures.append(executor.submit(process_qa, qa))

        for future in tqdm(
            as_completed(futures), total=len(futures), desc=f"Processing user {group_idx}"
        ):
            result = future.result()
            if result:
                search_results[conv_id].append(result)

    os.makedirs(f"results/locomo/{frame}-{version}/tmp/", exist_ok=True)
    with open(
        f"results/locomo/{frame}-{version}/tmp/{frame}_locomo_search_results_{group_idx}.json", "w"
    ) as f:
        json.dump(dict(search_results), f, indent=2)
        print(f"Save search results {group_idx}")

    return search_results


def main(frame, version="default", num_workers=1, top_k=20):
    load_dotenv()
    locomo_df = pd.read_json("data/locomo/locomo10.json")

    num_users = 10
    os.makedirs(f"results/locomo/{frame}-{version}/", exist_ok=True)
    all_search_results = defaultdict(list)

    for idx in range(num_users):
        # try:
            print(f"Processing user {idx}...")
            user_results = process_user(idx, locomo_df, frame, version, top_k, num_workers)
            for conv_id, results in user_results.items():
                all_search_results[conv_id].extend(results)
        # except Exception as e:
        #     print(f"User {idx} generated an exception: {e}")

    with open(f"results/locomo/{frame}-{version}/{frame}_locomo_search_results.json", "w") as f:
        json.dump(dict(all_search_results), f, indent=2)
        print("Save all search results")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--lib",
        type=str,
        choices=["zep", "memos", "mem0", "mem0_graph", "memos-api", "memobase"],
        default='memos-api'
    )
    parser.add_argument(
        "--version",
        type=str,
        default="0917-test",
        help="Version identifier for saving results (e.g., 1010)",
    )
    parser.add_argument(
        "--workers", type=int, default=10, help="Number of parallel workers to process users"
    )
    parser.add_argument(
        "--top_k", type=int, default=20, help="Number of results to retrieve in search queries"
    )
    args = parser.parse_args()
    lib = args.lib
    version = args.version
    workers = args.workers
    top_k = args.top_k

    main(lib, version, workers, top_k)
