import argparse
import csv
import json
import os
import sys

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from time import time

from tqdm import tqdm


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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


def mem0_search(client, query, user_id, top_k):
    start = time()
    results = client.search(query, user_id, top_k)
    memory = [f"{memory['created_at']}: {memory['memory']}" for memory in results["results"]]
    if client.enable_graph:
        graph = "\n".join(
            [
                f"  - 'source': {item.get('source', '?')} -> 'target': {item.get('target', '?')} "
                f"(relationship: {item.get('relationship', '?')})"
                for item in results.get("relations", [])
            ]
        )
        context = MEM0_GRAPH_CONTEXT_TEMPLATE.format(
            user_id=user_id, memories=memory, relations=graph
        )
    else:
        context = MEM0_CONTEXT_TEMPLATE.format(user_id=user_id, memories=memory)
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memobase_search(client, query, user_id, top_k):
    start = time()
    context = client.search(query=query, user_id=user_id, top_k=top_k)
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memos_search(client, user_id, query, top_k):
    start = time()
    results = client.search(query=query, user_id=user_id, top_k=top_k)
    search_memories = (
        "\n".join(item["memory"] for cube in results["text_mem"] for item in cube["memories"])
        + f"\n{results.get('pref_string', '')}"
    )
    context = MEMOS_CONTEXT_TEMPLATE.format(user_id=user_id, memories=search_memories)

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def supermemory_search(client, query, user_id, top_k):
    start = time()
    context = client.search(query, user_id, top_k)
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def memu_search(client, query, user_id, top_k):
    start = time()
    results = client.search(query, user_id, top_k)
    context = "\n".join(results)
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def build_jsonl_index(jsonl_path):
    """
    Scan the JSONL file once to build a mapping: {key: file_offset}.
    Assumes each line is a JSON object with a single key-value pair.
    """
    index = {}
    with open(jsonl_path, encoding="utf-8") as f:
        while True:
            offset = f.tell()
            line = f.readline()
            if not line:
                break
            key = next(iter(json.loads(line).keys()))
            index[key] = offset
    return index


def load_context_by_id(jsonl_path, offset):
    with open(jsonl_path, encoding="utf-8") as f:
        f.seek(offset)
        item = json.loads(f.readline())
        return next(iter(item.values()))


def load_rows(csv_path):
    with open(csv_path, newline="", encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        for _, row in enumerate(reader, start=1):
            row_data = {}
            for column_name, value in row.items():
                row_data[column_name] = value
            yield row_data


def load_rows_with_context(csv_path, jsonl_path):
    jsonl_index = build_jsonl_index(jsonl_path)

    with open(csv_path, newline="", encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        prev_sid = None
        prev_context = None

        for _, row in enumerate(reader, start=1):
            row_data = {}
            for column_name, value in row.items():
                row_data[column_name] = value

            sid = row_data["shared_context_id"]
            if sid != prev_sid:
                current_context = load_context_by_id(jsonl_path, jsonl_index[sid])

                prev_sid = sid
                prev_context = current_context
            else:
                current_context = prev_context

            yield row_data, current_context


def count_csv_rows(csv_path):
    with open(csv_path, newline="", encoding="utf-8") as f:
        return sum(1 for _ in f) - 1


def process_user(row_data, conv_idx, frame, version, top_k=20):
    persona_id = row_data["persona_id"]
    question_id = row_data["question_id"]
    question_type = row_data["question_type"]
    topic = row_data["topic"]
    question = row_data["user_question_or_message"]
    correct_answer = row_data["correct_answer"]
    all_options = row_data["all_options"]
    user_id = f"pm_exper_user_{conv_idx}_{version}"
    print(f"\n🔍 Processing conversation {conv_idx} for user {user_id}...")

    search_results = defaultdict(list)
    print("\n" + "-" * 80)
    print(f"🔎 [{conv_idx + 1}/589] Processing conversation {conv_idx}")
    print(f"❓ Question: {question}")
    print(f"🗂️  Options: {all_options}")
    print(f"🏷️  Type: {question_type}")
    print("-" * 80)

    existing_results, exists = load_existing_results(frame, version, conv_idx)
    if exists:
        print(f"♻️  Using existing results for conversation {conv_idx}")
        return existing_results

    if frame == "zep":
        from utils.client import ZepClient

        client = ZepClient()
        print("🔌 Using Zep client for search...")
        context, duration_ms = zep_search(client, user_id, question)

    elif frame == "mem0" or frame == "mem0-graph":
        from utils.client import Mem0Client

        client = Mem0Client(enable_graph="graph" in frame)
        print("🔌 Using Mem0 API client for search...")
        context, duration_ms = mem0_search(client, question, user_id, top_k)
    elif frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
        print("🔌 Using Memos API client for search...")
        context, duration_ms = memos_search(client, user_id, question, top_k=top_k)
    elif frame == "supermemory":
        from utils.client import SupermemoryClient

        client = SupermemoryClient()
        print("🔌 Using supermemory client for search...")
        context, duration_ms = supermemory_search(client, question, user_id, top_k)
    elif frame == "memu":
        from utils.client import MemuClient

        client = MemuClient()
        print("🔌 Using memu client for search...")
        context, duration_ms = memu_search(client, question, user_id, top_k)
    elif frame == "memobase":
        from utils.client import MemobaseClient

        client = MemobaseClient()
        print("🔌 Using Memobase client for search...")
        context, duration_ms = memobase_search(client, question, user_id, top_k)
    elif frame == "memos-api-online":
        from utils.client import MemosApiOnlineClient

        client = MemosApiOnlineClient()
        print("🔌 Using memos-api-online client for search...")
        context, duration_ms = memos_search(client, question, user_id, top_k)

    search_results[user_id].append(
        {
            "user_id": user_id,
            "question": question,
            "category": question_type,
            "persona_id": persona_id,
            "question_id": question_id,
            "all_options": all_options,
            "topic": topic,
            "golden_answer": correct_answer,
            "search_context": context,
            "search_duration_ms": duration_ms,
        }
    )

    os.makedirs(f"results/pm/{frame}-{version}/tmp", exist_ok=True)
    with open(
        f"results/pm/{frame}-{version}/tmp/{frame}_pm_search_results_{conv_idx}.json", "w"
    ) as f:
        json.dump(search_results, f, indent=4)
    print(f"💾 Search results for conversation {conv_idx} saved...")
    print("-" * 80)

    return search_results


def load_existing_results(frame, version, group_idx):
    result_path = f"results/pm/{frame}-{version}/tmp/{frame}_pm_search_results_{group_idx}.json"
    if os.path.exists(result_path):
        try:
            with open(result_path) as f:
                return json.load(f), True
        except Exception as e:
            print(f"❌ Error loading existing results for group {group_idx}: {e}")
    return {}, False


def main(frame, version, top_k=20, num_workers=2):
    print("\n" + "=" * 80)
    print(f"🔍 PERSONAMEM SEARCH - {frame.upper()} v{version}".center(80))
    print("=" * 80)

    question_csv_path = "data/personamem/questions_32k.csv"
    context_jsonl_path = "data/personamem/shared_contexts_32k.jsonl"
    total_rows = count_csv_rows(question_csv_path)

    print(f"📚 Loaded PersonaMem dataset from {question_csv_path} and {context_jsonl_path}")
    print(f"📊 Total conversations: {total_rows}")
    print(f"⚙️  Search parameters: top_k={top_k}, workers={num_workers}")
    print("-" * 80)

    all_search_results = defaultdict(list)
    start_time = datetime.now()

    all_data = list(load_rows_with_context(question_csv_path, context_jsonl_path))
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        future_to_idx = {
            executor.submit(
                process_user,
                row_data=row_data,
                version=version,
                conv_idx=idx,
                frame=frame,
            ): idx
            for idx, (row_data, _) in enumerate(all_data)
        }

        for future in tqdm(
            as_completed(future_to_idx), total=len(future_to_idx), desc="Processing conversations"
        ):
            idx = future_to_idx[future]
            try:
                search_results = future.result()
                for user_id, results in search_results.items():
                    all_search_results[user_id].extend(results)
                print(f"✅ Conversation {idx} processed successfully.")
            except Exception as exc:
                print(f"\n❌ Conversation {idx} generated an exception: {exc}")

    end_time = datetime.now()
    elapsed_time = end_time - start_time
    elapsed_time_str = str(elapsed_time).split(".")[0]

    print("\n" + "=" * 80)
    print("✅ SEARCH COMPLETE".center(80))
    print("=" * 80)
    print(f"⏱️  Total time taken to search {total_rows} users: {elapsed_time_str}")
    print(f"🔄 Framework: {frame} | Version: {version} | Workers: {num_workers}")

    with open(f"results/pm/{frame}-{version}/{frame}_pm_search_results.json", "w") as f:
        json.dump(dict(all_search_results), f, indent=4)
    print(f"📁 Results saved to: mresults/pm/{frame}-{version}/{frame}_pm_search_results.json")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PersonaMem Search Script")
    parser.add_argument(
        "--lib",
        type=str,
        choices=[
            "memos-api-online",
            "mem0",
            "mem0_graph",
            "memos-api",
            "memobase",
            "memu",
            "supermemory",
        ],
        default="memos-api",
    )
    parser.add_argument(
        "--version", type=str, default="default", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--top_k", type=int, default=20, help="Number of top results to retrieve from the search."
    )
    parser.add_argument(
        "--workers", type=int, default=3, help="Number of parallel workers for processing users."
    )

    args = parser.parse_args()

    main(frame=args.lib, version=args.version, top_k=args.top_k, num_workers=args.workers)
