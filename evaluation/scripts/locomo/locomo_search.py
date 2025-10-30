import argparse
import json
import os
import sys

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import time

import pandas as pd

from dotenv import load_dotenv
from tqdm import tqdm


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)


def mem0_search(client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b):
    from prompts import TEMPLATE_MEM0

    start = time()
    search_speaker_a_results = client.search(query, speaker_a_user_id, top_k)
    search_speaker_b_results = client.search(query, speaker_b_user_id, top_k)

    search_speaker_a_memory = [
        f"{memory['created_at']}: {memory['memory']}"
        for memory in search_speaker_a_results["results"]
    ]
    search_speaker_b_memory = [
        f"{memory['created_at']}: {memory['memory']}"
        for memory in search_speaker_b_results["results"]
    ]

    context = TEMPLATE_MEM0.format(
        speaker_1_user_id=speaker_a,
        speaker_1_memories=json.dumps(search_speaker_a_memory, indent=4),
        speaker_2_user_id=speaker_b,
        speaker_2_memories=json.dumps(search_speaker_b_memory, indent=4),
    )
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def mem0_graph_search(
    client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
):
    from prompts import TEMPLATE_MEM0_GRAPH

    start = time()
    search_speaker_a_results = client.search(query, speaker_a_user_id, top_k)
    search_speaker_b_results = client.search(query, speaker_b_user_id, top_k)

    search_speaker_a_memory = [
        f"{memory['created_at']}: {memory['memory']}"
        for memory in search_speaker_a_results["results"]
    ]
    search_speaker_b_memory = [
        f"{memory['created_at']}: {memory['memory']}"
        for memory in search_speaker_b_results["results"]
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
        speaker_1_user_id=speaker_a,
        speaker_1_memories=json.dumps(search_speaker_a_memory, indent=4),
        speaker_1_graph_memories=json.dumps(search_speaker_a_graph, indent=4),
        speaker_2_user_id=speaker_b,
        speaker_2_memories=json.dumps(search_speaker_b_memory, indent=4),
        speaker_2_graph_memories=json.dumps(search_speaker_b_graph, indent=4),
    )
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memos_api_search(
    client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
):
    from prompts import TEMPLATE_MEMOS

    start = time()
    search_a_results = client.search(query=query, user_id=speaker_a_user_id, top_k=top_k)
    search_b_results = client.search(query=query, user_id=speaker_b_user_id, top_k=top_k)

    speaker_a_context = (
        "\n".join([i["memory"] for i in search_a_results["text_mem"][0]["memories"]])
        + f"\n{search_a_results.get('pref_string', '')}"
    )
    speaker_b_context = (
        "\n".join([i["memory"] for i in search_b_results["text_mem"][0]["memories"]])
        + f"\n{search_b_results.get('pref_string', '')}"
    )

    context = TEMPLATE_MEMOS.format(
        speaker_1=speaker_a,
        speaker_1_memories=speaker_a_context,
        speaker_2=speaker_b,
        speaker_2_memories=speaker_b_context,
    )

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memobase_search(
    client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
):
    from prompts import TEMPLATE_MEMOBASE

    start = time()
    search_a_results = client.search(query=query, user_id=speaker_a_user_id, top_k=top_k)
    search_b_results = client.search(query=query, user_id=speaker_b_user_id, top_k=top_k)
    context = TEMPLATE_MEMOBASE.format(
        speaker_1_user_id=speaker_a,
        speaker_1_memories=search_a_results,
        indent=4,
        speaker_2_user_id=speaker_b,
        speaker_2_memories=search_b_results,
    )
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memu_search(client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b):
    from prompts import TEMPLATE_MEM0

    start = time()
    search_speaker_a_results = client.search(query, speaker_a_user_id, top_k)
    search_speaker_b_results = client.search(query, speaker_b_user_id, top_k)

    search_speaker_a_memory = "\n".join(search_speaker_a_results)
    search_speaker_b_memory = "\n".join(search_speaker_b_results)

    context = TEMPLATE_MEM0.format(
        speaker_1_user_id=speaker_a,
        speaker_1_memories=search_speaker_a_memory,
        speaker_2_user_id=speaker_b,
        speaker_2_memories=search_speaker_b_memory,
    )
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def supermemory_search(
    client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
):
    from prompts import TEMPLATE_MEM0

    start = time()
    search_speaker_a_results = client.search(query, speaker_a_user_id, top_k)
    search_speaker_b_results = client.search(query, speaker_b_user_id, top_k)

    context = TEMPLATE_MEM0.format(
        speaker_1_user_id=speaker_a,
        speaker_1_memories=search_speaker_a_results,
        speaker_2_user_id=speaker_b,
        speaker_2_memories=search_speaker_b_results,
    )
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def search_query(client, query, metadata, frame, version, top_k=20):
    _conv_id = metadata.get("conv_id")
    speaker_a = metadata.get("speaker_a")
    speaker_b = metadata.get("speaker_b")
    speaker_a_user_id = metadata.get("speaker_a_user_id")
    speaker_b_user_id = metadata.get("speaker_b_user_id")

    if frame == "mem0":
        context, duration_ms = mem0_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
        )
    elif frame == "mem0_graph":
        context, duration_ms = mem0_graph_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
        )
    elif "memos-api" in frame:
        context, duration_ms = memos_api_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
        )
    elif frame == "memobase":
        context, duration_ms = memobase_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
        )
    elif frame == "memu":
        context, duration_ms = memu_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
        )
    elif frame == "supermemory":
        conv_idx = metadata["conv_idx"]
        speaker_a_user_id = f"lcm{conv_idx}a_{version}"
        speaker_b_user_id = f"lcm{conv_idx}b_{version}"
        context, duration_ms = supermemory_search(
            client, query, speaker_a_user_id, speaker_b_user_id, top_k, speaker_a, speaker_b
        )
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


def process_user(conv_idx, locomo_df, frame, version, top_k=20, num_workers=1):
    search_results = defaultdict(list)
    qa_set = locomo_df["qa"].iloc[conv_idx]
    conversation = locomo_df["conversation"].iloc[conv_idx]
    speaker_a = conversation.get("speaker_a")
    speaker_b = conversation.get("speaker_b")
    speaker_a_user_id = f"locomo_exp_user_{conv_idx}_speaker_a_{version}"
    speaker_b_user_id = f"locomo_exp_user_{conv_idx}_speaker_b_{version}"
    conv_id = f"locomo_exp_user_{conv_idx}"

    existing_results, loaded = load_existing_results(frame, version, conv_idx)
    if loaded:
        print(f"Loaded existing results for group {conv_idx}")
        return existing_results

    client = None
    if frame == "mem0" or frame == "mem0_graph":
        from utils.client import Mem0Client

        client = Mem0Client(enable_graph="graph" in frame)
    elif frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
    elif frame == "memos-api-online":
        from utils.client import MemosApiOnlineClient

        client = MemosApiOnlineClient()
    elif frame == "memobase":
        from utils.client import MemobaseClient

        client = MemobaseClient()
    elif frame == "memu":
        from utils.client import MemuClient

        client = MemuClient()
    elif frame == "supermemory":
        from utils.client import SupermemoryClient

        client = SupermemoryClient()

    metadata = {
        "speaker_a": speaker_a,
        "speaker_b": speaker_b,
        "speaker_a_user_id": speaker_a_user_id,
        "speaker_b_user_id": speaker_b_user_id,
        "conv_idx": conv_idx,
        "conv_id": conv_id,
    }

    def process_qa(qa):
        query = qa.get("question")
        if qa.get("category") == 5:
            return None
        context, duration_ms = search_query(client, query, metadata, frame, version, top_k=top_k)

        if not context:
            print(f"No context found for query: {query}")
            context = ""
        return {"query": query, "context": context, "duration_ms": duration_ms}

    futures = []
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        for qa in qa_set:
            futures.append(executor.submit(process_qa, qa))

        for future in tqdm(
            as_completed(futures), total=len(futures), desc=f"Processing user {conv_idx}"
        ):
            result = future.result()
            if result:
                search_results[conv_id].append(result)

    os.makedirs(f"results/locomo/{frame}-{version}/tmp/", exist_ok=True)
    with open(
        f"results/locomo/{frame}-{version}/tmp/{frame}_locomo_search_results_{conv_idx}.json", "w"
    ) as f:
        json.dump(dict(search_results), f, indent=2)
        print(f"Save search results {conv_idx}")

    return search_results


def main(frame, version="default", num_workers=1, top_k=20):
    load_dotenv()
    locomo_df = pd.read_json("data/locomo/locomo10.json")

    num_users = 10
    os.makedirs(f"results/locomo/{frame}-{version}/", exist_ok=True)
    all_search_results = defaultdict(list)

    for idx in range(num_users):
        print(f"Processing user {idx}...")
        user_results = process_user(idx, locomo_df, frame, version, top_k, num_workers)
        for conv_id, results in user_results.items():
            all_search_results[conv_id].extend(results)

    with open(f"results/locomo/{frame}-{version}/{frame}_locomo_search_results.json", "w") as f:
        json.dump(dict(all_search_results), f, indent=2)
        print("Save all search results")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--lib",
        type=str,
        choices=[
            "mem0",
            "mem0_graph",
            "memos-api",
            "memos-api-online",
            "memobase",
            "memu",
            "supermemory",
        ],
        default="memos-api",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="default",
        help="Version identifier for saving results (e.g., 1010)",
    )
    parser.add_argument(
        "--workers", type=int, default=5, help="Number of parallel workers to process users"
    )
    parser.add_argument(
        "--top_k", type=int, default=15, help="Number of results to retrieve in search queries"
    )
    args = parser.parse_args()
    lib = args.lib
    version = args.version
    workers = args.workers
    top_k = args.top_k

    main(lib, version, workers, top_k)
