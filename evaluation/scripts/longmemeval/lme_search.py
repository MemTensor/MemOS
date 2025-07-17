import argparse
import json
import os
import sys


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from time import time

import pandas as pd

from tqdm import tqdm
from utils.client import mem0_client, memos_client, zep_client
from utils.memos_filters import filter_memory_data
from utils.prompts import (
    MEM0_CONTEXT_TEMPLATE,
    MEM0_GRAPH_CONTEXT_TEMPLATE,
    MEMOS_CONTEXT_TEMPLATE,
    ZEP_CONTEXT_TEMPLATE,
)


def zep_search(client, user_id, query, top_k=20):
    start = time()
    nodes_result = client.graph.search(
        query=query,
        user_id=user_id,
        scope="nodes",
        reranker="rrf",
        limit=top_k,
    )
    edges_result = client.graph.search(
        query=query,
        user_id=user_id,
        scope="edges",
        reranker="cross_encoder",
        limit=top_k,
    )

    nodes = nodes_result.nodes
    edges = edges_result.edges

    facts = [f"  - {edge.fact} (event_time: {edge.valid_at})" for edge in edges]
    entities = [f"  - {node.name}: {node.summary}" for node in nodes]
    context = ZEP_CONTEXT_TEMPLATE.format(facts="\n".join(facts), entities="\n".join(entities))

    duration_ms = (time() - start) * 1000

    return context, duration_ms


def mem0_search(client, user_id, query, top_k=20, enable_graph=False, frame="mem0-api"):
    start = time()

    if frame == "mem0-local":
        results = client.search(
            query=query,
            user_id=user_id,
            top_k=top_k,
        )
        search_memories = "\n".join(
            [
                f"  - {item['memory']} (date: {item['metadata']['timestamp']})"
                for item in results["results"]
            ]
        )
        search_graph = (
            "\n".join(
                [
                    f"  - 'source': {item.get('source', '?')} -> 'target': {item.get('destination', '?')} (relationship: {item.get('relationship', '?')})"
                    for item in results.get("relations", [])
                ]
            )
            if enable_graph
            else ""
        )

    elif frame == "mem0-api":
        results = client.search(
            query=query,
            user_id=user_id,
            top_k=top_k,
            version="v2",
            output_format="v1.1",
            enable_graph=enable_graph,
            filters={"AND": [{"user_id": user_id}, {"run_id": "*"}]},
        )
        search_memories = "\n".join(
            [f"  - {item['memory']} (date: {item['created_at']})" for item in results["results"]]
        )
        search_graph = (
            "\n".join(
                [
                    f"  - 'source': {item.get('source', '?')} -> 'target': {item.get('target', '?')} (relationship: {item.get('relationship', '?')})"
                    for item in results.get("relations", [])
                ]
            )
            if enable_graph
            else ""
        )
    if enable_graph:
        context = MEM0_GRAPH_CONTEXT_TEMPLATE.format(
            user_id=user_id, memories=search_memories, relations=search_graph
        )
    else:
        context = MEM0_CONTEXT_TEMPLATE.format(user_id=user_id, memories=search_memories)
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memos_search(client, user_id, query, frame="memos-local"):
    start = time()

    results = client.search(
        query=query,
        user_id=user_id,
    )

    search_memories = filter_memory_data(results)["text_mem"][0]["memories"]
    context = MEMOS_CONTEXT_TEMPLATE.format(user_id=user_id, memories=search_memories)

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def process_user(lme_df, conv_idx, frame, version, top_k=20):
    row = lme_df.iloc[conv_idx]
    question = row["question"]
    sessions = row["haystack_sessions"]
    question_type = row["question_type"]
    question_date = row["question_date"]
    answer = row["answer"]
    answer_session_ids = set(row["answer_session_ids"])
    haystack_session_ids = row["haystack_session_ids"]
    user_id = f"lme_exper_user_{conv_idx!s}"
    id_to_session = dict(zip(haystack_session_ids, sessions, strict=False))
    answer_sessions = [id_to_session[sid] for sid in answer_session_ids if sid in id_to_session]
    answer_evidences = []

    for session in answer_sessions:
        for turn in session:
            if turn.get("has_answer"):
                data = turn.get("role") + " : " + turn.get("content")
                answer_evidences.append(data)

    search_results = defaultdict(list)
    print("\n" + "-" * 80)
    print(f"🔎 \033[1;36m[{conv_idx + 1}/{len(lme_df)}] Processing conversation {conv_idx}\033[0m")
    print(f"❓ Question: \033[93m{question}\033[0m")
    print(f"📅 Date: \033[92m{question_date}\033[0m")
    print(f"🏷️  Type: \033[94m{question_type}\033[0m")
    print("-" * 80)

    existing_results, exists = load_existing_results(frame, version, conv_idx)
    if exists:
        print(f"♻️  \033[93mUsing existing results for conversation {conv_idx}\033[0m")
        return existing_results

    if frame == "zep":
        client = zep_client()
        print("🔌 \033[1mUsing \033[94mZep client\033[0m \033[1mfor search...\033[0m")
        context, duration_ms = zep_search(client, user_id, question)

    elif frame == "mem0-local":
        client = mem0_client(mode="local")
        print("🔌 \033[1mUsing \033[94mMem0 Local client\033[0m \033[1mfor search...\033[0m")
        context, duration_ms = mem0_search(client, user_id, question, top_k=top_k, frame=frame)
    elif frame == "mem0-api":
        client = mem0_client(mode="api")
        print("🔌 \033[1mUsing \033[94mMem0 API client\033[0m \033[1mfor search...\033[0m")
        context, duration_ms = mem0_search(client, user_id, question, top_k=top_k, frame=frame)
    elif frame == "memos-local":
        client = memos_client(
            mode="local",
            db_name=f"lme_{frame}-{version}-{user_id.replace('_', '')}",
            user_id=user_id,
            top_k=20,
            mem_cube_path=f"results/lme/{frame}-{version}/storages/{user_id}",
            mem_cube_config_path="configs/mem_cube_config.json",
            mem_os_config_path="configs/mos_memos_config.json",
            addorsearch="search",
        )
        print("🔌 \033[1mUsing \033[94mMemos Local client\033[0m \033[1mfor search...\033[0m")
        context, duration_ms = memos_search(client, user_id, question, frame=frame)

    search_results[user_id].append(
        {
            "question": question,
            "category": question_type,
            "date": question_date,
            "golden_answer": answer,
            "answer_evidences": answer_evidences,
            "search_context": context,
            "search_duration_ms": duration_ms,
        }
    )

    os.makedirs(f"results/lme/{frame}-{version}/tmp", exist_ok=True)
    with open(
        f"results/lme/{frame}-{version}/tmp/{frame}_lme_search_results_{conv_idx}.json", "w"
    ) as f:
        json.dump(search_results, f, indent=4)
    print(f"💾 \033[92mSearch results for conversation {conv_idx} saved...\033[0m")
    print("-" * 80)

    return search_results


def load_existing_results(frame, version, group_idx):
    result_path = (
        f"results/locomo/{frame}-{version}/tmp/{frame}_locomo_search_results_{group_idx}.json"
    )
    if os.path.exists(result_path):
        try:
            with open(result_path) as f:
                return json.load(f), True
        except Exception as e:
            print(f"\033[91m❌ Error loading existing results for group {group_idx}: {e}\033[0m")
    return {}, False


def main(frame, version, top_k=20, num_workers=2):
    print("\n" + "=" * 80)
    print(f"🔍 \033[1;36mLONGMEMEVAL SEARCH - {frame.upper()} v{version}\033[0m".center(80))
    print("=" * 80)

    lme_df = pd.read_json("data/longmemeval/longmemeval_s.json")
    print(
        "📚 \033[1mLoaded LongMemeval dataset\033[0m from \033[94mdata/longmemeval/longmemeval_s.json\033[0m"
    )
    num_multi_sessions = len(lme_df)
    print(f"👥 Number of users: \033[93m{num_multi_sessions}\033[0m")
    print(
        f"⚙️  Search parameters: top_k=\033[94m{top_k}\033[0m, workers=\033[94m{num_workers}\033[0m"
    )
    print("-" * 80)

    all_search_results = defaultdict(list)
    start_time = datetime.now()

    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        future_to_idx = {
            executor.submit(process_user, lme_df, idx, frame, version, top_k): idx
            for idx in range(num_multi_sessions)
        }

        for future in tqdm(
            as_completed(future_to_idx), total=num_multi_sessions, desc="📊 Processing users"
        ):
            idx = future_to_idx[future]
            try:
                search_results = future.result()
                for user_id, results in search_results.items():
                    all_search_results[user_id].extend(results)
            except Exception as e:
                print(f"\033[91m❌ Error processing user {idx}: {e}\033[0m")

    end_time = datetime.now()
    elapsed_time = end_time - start_time
    elapsed_time_str = str(elapsed_time).split(".")[0]

    print("\n" + "=" * 80)
    print("✅ \033[1;32mSEARCH COMPLETE\033[0m".center(80))
    print("=" * 80)
    print(
        f"⏱️  Total time taken to search \033[93m{num_multi_sessions}\033[0m users: \033[92m{elapsed_time_str}\033[0m"
    )
    print(
        f"🔄 Framework: \033[94m{frame}\033[0m | Version: \033[94m{version}\033[0m | Workers: \033[94m{num_workers}\033[0m"
    )

    with open(f"results/lme/{frame}-{version}/{frame}_lme_search_results.json", "w") as f:
        json.dump(dict(all_search_results), f, indent=4)
    print(
        f"📁 Results saved to: \033[1;94mresults/lme/{frame}-{version}/{frame}_lme_search_results.json\033[0m"
    )
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LongMemeval Search Script")
    parser.add_argument("--lib", type=str, choices=["mem0-local", "mem0-api", "memos-local"])
    parser.add_argument(
        "--version", type=str, default="v1", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--top_k", type=int, default=20, help="Number of top results to retrieve from the search."
    )
    parser.add_argument(
        "--workers", type=int, default=3, help="Number of runs for LLM-as-a-Judge evaluation."
    )

    args = parser.parse_args()

    main(frame=args.lib, version=args.version, top_k=args.top_k, num_workers=args.workers)
