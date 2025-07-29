import argparse
import json
import os
import sys

import pandas as pd
import tiktoken


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from time import time

from dotenv import load_dotenv
from locomo.locomo_rag import RAGManager
from openai import OpenAI
from tqdm import tqdm
from utils.prompts import (
    MEMOS_CONTEXT_TEMPLATE,
)


load_dotenv()
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"), base_url=os.getenv("OPENAI_BASE_URL"))


class RAGFullContext(RAGManager):
    def __init__(self, data_path="data/longmemeval/longmemeval_s.json", chunk_size=1024, k=1):
        super().__init__(data_path=data_path, chunk_size=chunk_size, k=k)

    def get_dataset(self):
        with open(self.data_path) as f:
            data = json.load(f)
        return data

    def split_chunks(self, message_content, chunk_size):
        print(f"In split_chunks function the chunk_size is:{chunk_size}")
        encoding = tiktoken.encoding_for_model(os.getenv("EMBEDDING_MODEL"))

        if isinstance(message_content, list):
            # Joining together into a string
            documents = "\n".join(message_content)
        else:
            documents = str(message_content)
        if chunk_size == -1:
            return [documents], []

        # Add this parameter to prevent special character errors
        tokens = encoding.encode(documents, disallowed_special=())

        chunks = []
        for i in tqdm(range(0, len(tokens), chunk_size), desc="Splitting chunks"):
            chunk_tokens = tokens[i : i + chunk_size]
            chunk = encoding.decode(chunk_tokens)
            chunks.append(chunk)

        embeddings = []
        for chunk in tqdm(chunks, desc="Calculating embeddings"):
            embedding = self.calculate_embedding(chunk)
            embeddings.append(embedding)

        return chunks, embeddings

    def split_chunks2(self, message_content, chunk_size):
        print(f"In split_chunks2 function the chunk_size is:{chunk_size}")
        encoding = tiktoken.encoding_for_model(os.getenv("EMBEDDING_MODEL"))

        # Ensure input is a list
        if not isinstance(message_content, list):
            message_content = [str(message_content)]

        all_tokens = []
        for text in message_content:
            # Prevents special character errors
            tokens = encoding.encode(text, disallowed_special=())
            all_tokens.extend(tokens)

        if chunk_size == -1:
            # Return the original text and empty embeddings (depending on the situation)
            return message_content, []

        chunks = []
        for i in tqdm(range(0, len(all_tokens), chunk_size), desc="Splitting chunks"):
            chunk_tokens = all_tokens[i : i + chunk_size]
            chunk = encoding.decode(chunk_tokens)
            chunks.append(chunk)

        embeddings = []
        for chunk in tqdm(chunks, desc="Calculating embeddings"):
            embedding = self.calculate_embedding(chunk)
            embeddings.append(embedding)

        return chunks, embeddings


def rag_search(client, user_id, query, top_k, frame):
    print(f"The number_chunks is:{client.k}")
    start = time()
    data = client.get_dataset()

    all_contents = []
    message = []
    combine_info = []
    cleaned_chat_history = ""
    for item in data:
        question_id = item.get("question_id")
        question = item.get("question")
        answer = item.get("answer")
        print(f"Question_id: {question_id} --> question: {question} <----> answer is:{answer}")
        haystack_sessions = item.get("haystack_sessions", [])

        for session in haystack_sessions:
            for msg in session:
                role = msg.get("role")
                content = msg.get("content")
                if not content:
                    continue
                all_contents.append(content)
                message.append({"role": msg["role"], "content": msg["content"]})
                cleaned_chat_history = f"{role}: {content}\n"
                combine_info.append(cleaned_chat_history)

    with open("results/output/combine_info.json", "w", encoding="utf-8") as f:
        json.dump(combine_info, f, ensure_ascii=False, indent=2)

    with open("results/output/message_output.json", "w", encoding="utf-8") as f:
        json.dump(message, f, ensure_ascii=False, indent=2)

    chunks, embeddings = client.split_chunks(combine_info, client.chunk_size)
    with open("results/output/chunks_output.json", "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)
    print("Writing chunks output have finished!")

    result = []
    # Full content retriever
    if client.chunk_size == -1:
        result = chunks
    else:
        result = client.search(query, chunks, embeddings, k=client.k)
    context = MEMOS_CONTEXT_TEMPLATE.format(user_id=user_id, memories=result)
    duration_ms = (time() - start) * 1000
    return context, duration_ms


def process_user(lme_df, conv_idx, frame, version, chunk_size, num_chunks, top_k=20):
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

    if frame == "rag":
        rag_fullcontext_obj = RAGFullContext(chunk_size=chunk_size, k=num_chunks)
        print("🔌 \033[1mUsing \033[94mRAG API client\033[0m \033[1mfor search...\033[0m")
        context, duration_ms = rag_search(rag_fullcontext_obj, user_id, question, top_k, frame)

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


def main(frame, version, chunk_size, num_chunks, top_k=20, num_workers=2):
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
            executor.submit(
                process_user, lme_df, idx, frame, version, chunk_size, num_chunks, top_k
            ): idx
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
    parser.add_argument("--lib", type=str, choices=["rag"])
    parser.add_argument(
        "--version", type=str, default="v1", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--top_k", type=int, default=20, help="Number of top results to retrieve from the search."
    )
    parser.add_argument(
        "--workers", type=int, default=10, help="Number of runs for LLM-as-a-Judge evaluation."
    )
    parser.add_argument(
        "--chunk_size",
        type=int,
        default=1024,
        help="If chunk size equal -1, it means the full context retrieval.",
    )
    parser.add_argument(
        "--num_chunks",
        type=int,
        default=1,
        help="The num_chunks only have two values(1 or 2), it means the num_chunks * chunk_size, if num_chunks more than 2, model number of token will exceed the window size.",
    )

    args = parser.parse_args()

    main(
        frame=args.lib,
        version=args.version,
        chunk_size=args.chunk_size,
        num_chunks=args.num_chunks,
        top_k=args.top_k,
        num_workers=args.workers,
    )
