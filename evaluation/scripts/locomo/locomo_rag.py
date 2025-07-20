"""
Modify the code from the mem0 project
"""

import argparse
import concurrent.futures
import json
import os
import threading
import time

from collections import defaultdict

import numpy as np
import tiktoken

from dotenv import load_dotenv
from jinja2 import Template
from openai import OpenAI
from tqdm import tqdm


load_dotenv()

PROMPT = """
# Question:
{{QUESTION}}

# Context:
{{CONTEXT}}

# Short answer:
"""

TECHNIQUES = ["rag"]


class RAGManager:
    def __init__(self, data_path="data/locomo/locomo10_rag.json", chunk_size=500, k=2):
        self.model = os.getenv("MODEL")
        self.client = OpenAI()
        self.data_path = data_path
        self.chunk_size = chunk_size
        self.k = k

    def generate_response(self, question, context):
        template = Template(PROMPT)
        prompt = template.render(CONTEXT=context, QUESTION=question)

        max_retries = 3
        retries = 0

        while retries <= max_retries:
            try:
                t1 = time.time()
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a helpful assistant that can answer "
                            "questions based on the provided context."
                            "If the question involves timing, use the conversation date for reference."
                            "Provide the shortest possible answer."
                            "Use words directly from the conversation when possible."
                            "Avoid using subjects in your answer.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0,
                )
                t2 = time.time()
                if response and response.choices:
                    content = response.choices[0].message.content
                    if content is not None:
                        return content.strip(), t2 - t1
                    else:
                        return "No content returned", t2 - t1
                        print("❎ No content returned!")
                else:
                    return "Empty response", t2 - t1
            except Exception as e:
                retries += 1
                if retries > max_retries:
                    raise e
                time.sleep(1)  # Wait before retrying

    def clean_chat_history(self, chat_history):
        cleaned_chat_history = ""
        for c in chat_history:
            cleaned_chat_history += f"{c['timestamp']} | {c['speaker']}: {c['text']}\n"

        return cleaned_chat_history

    def calculate_embedding(self, document):
        response = self.client.embeddings.create(model=os.getenv("EMBEDDING_MODEL"), input=document)
        return response.data[0].embedding

    def calculate_similarity(self, embedding1, embedding2):
        return np.dot(embedding1, embedding2) / (
            np.linalg.norm(embedding1) * np.linalg.norm(embedding2)
        )

    def search(self, query, chunks, embeddings, k=1):
        """
        Search for the top-k most similar chunks to the query.

        Args:
            query: The query string
            chunks: List of text chunks
            embeddings: List of embeddings for each chunk
            k: Number of top chunks to return (default: 1)

        Returns:
            combined_chunks: The combined text of the top-k chunks
            search_time: Time taken for the search
        """
        t1 = time.time()
        query_embedding = self.calculate_embedding(query)
        similarities = [
            self.calculate_similarity(query_embedding, embedding) for embedding in embeddings
        ]

        # Get indices of top-k most similar chunks
        top_indices = [np.argmax(similarities)] if k == 1 else np.argsort(similarities)[-k:][::-1]
        # Combine the top-k chunks
        combined_chunks = "\n<->\n".join([chunks[i] for i in top_indices])

        t2 = time.time()
        return combined_chunks, t2 - t1

    def create_chunks(self, chat_history, chunk_size=500):
        """
        Create chunks using tiktoken for more accurate token counting
        """
        # Get the encoding for the model
        encoding = tiktoken.encoding_for_model(os.getenv("EMBEDDING_MODEL"))

        documents = self.clean_chat_history(chat_history)

        if chunk_size == -1:
            return [documents], []

        chunks = []

        # Encode the document
        tokens = encoding.encode(documents)

        # Split into chunks based on token count
        for i in range(0, len(tokens), chunk_size):
            chunk_tokens = tokens[i : i + chunk_size]
            chunk = encoding.decode(chunk_tokens)
            chunks.append(chunk)

        embeddings = []
        for chunk in chunks:
            embedding = self.calculate_embedding(chunk)
            embeddings.append(embedding)

        return chunks, embeddings

    def process_all_conversations(self, output_file_path):
        with open(self.data_path) as f:
            data = json.load(f)

        final_results = defaultdict(list)
        for key, value in tqdm(data.items(), desc="Processing conversations"):
            chat_history = value["conversation"]
            questions = value["question"]

            chunks, embeddings = self.create_chunks(chat_history, self.chunk_size)

            for item in tqdm(questions, desc="Answering questions", leave=False):
                question = item["question"]
                answer = item.get("answer", "")
                category = item["category"]

                if self.chunk_size == -1:
                    context = chunks[0]
                    search_time = 0
                else:
                    context, search_time = self.search(question, chunks, embeddings, k=self.k)
                response, response_time = self.generate_response(question, context)

                final_results[key].append(
                    {
                        "question": question,
                        "answer": answer,
                        "category": category,
                        "context": context,
                        "response": response,
                        "search_time": search_time,
                        "response_time": response_time,
                    }
                )
                with open(output_file_path, "w+") as f:
                    json.dump(final_results, f, indent=4)

        # Save results
        with open(output_file_path, "w+") as f:
            json.dump(final_results, f, indent=4)
        print("The original rag file have been generated!")


class Experiment:
    def __init__(self, technique_type, chunk_size):
        self.technique_type = technique_type
        self.chunk_size = chunk_size

    def run(self):
        print(
            f"Running experiment with technique: {self.technique_type}, chunk size: {self.chunk_size}"
        )


def process_item(item_data):
    k, v = item_data
    local_results = defaultdict(list)

    for item in tqdm(v):
        gt_answer = str(item["answer"])
        pred_answer = str(item["response"])
        category = str(item["category"])
        question = str(item["question"])
        search_time = str(item["search_time"])
        response_time = str(item["response_time"])
        search_context = str(item["context"])

        # Skip category 5
        if category == "5":
            continue

        local_results[k].append(
            {
                "question": question,
                "golden_answer": gt_answer,
                "answer": pred_answer,
                "category": int(category),
                "response_duration_ms": float(response_time) * 1000,
                "search_duration_ms": float(search_time) * 1000,
                "search_context": search_context,
            }
        )

    return local_results


def rename_json_keys(file_path):
    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)

    new_data = {}
    for old_key in data:
        new_key = f"locomo_exp_user_{old_key}"
        new_data[new_key] = data[old_key]

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(new_data, f, indent=2, ensure_ascii=False)


def generate_response_file(file_path):
    parser = argparse.ArgumentParser(description="Evaluate RAG results")

    parser.add_argument(
        "--output_folder",
        type=str,
        default="default_locomo_responses.json",
        help="Path to save the evaluation results",
    )
    parser.add_argument(
        "--max_workers", type=int, default=10, help="Maximum number of worker threads"
    )
    parser.add_argument("--chunk_size", type=int, default=2000, help="Chunk size for processing")
    parser.add_argument("--num_chunks", type=int, default=2, help="Number of chunks to process")
    parser.add_argument("--frame", type=str, default="rag")

    args = parser.parse_args()
    with open(file_path) as f:
        data = json.load(f)

    results = defaultdict(list)
    results_lock = threading.Lock()

    # Use ThreadPoolExecutor with specified workers
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        futures = [executor.submit(process_item, item_data) for item_data in data.items()]

        for future in tqdm(concurrent.futures.as_completed(futures), total=len(futures)):
            local_results = future.result()
            with results_lock:
                for k, items in local_results.items():
                    results[k].extend(items)

    # Save results to JSON file
    with open(file_path, "w") as f:
        json.dump(results, f, indent=4)

    rename_json_keys(file_path)
    print(f"Results saved to {file_path}")


def main():
    parser = argparse.ArgumentParser(description="Run memory experiments")
    parser.add_argument(
        "--technique_type", choices=TECHNIQUES, default="rag", help="Memory technique to use"
    )
    parser.add_argument("--chunk_size", type=int, default=2000, help="Chunk size for processing")
    parser.add_argument(
        "--output_folder",
        type=str,
        default="results/locomo/rag-default/",
        help="Output path for results",
    )
    parser.add_argument("--top_k", type=int, default=30, help="Number of top memories to retrieve")
    parser.add_argument("--num_chunks", type=int, default=2, help="Number of chunks to process")
    parser.add_argument("--frame", type=str, default="rag")
    parser.add_argument("--version", type=str, default="default")

    args = parser.parse_args()

    response_path = f"{args.frame}_locomo_responses.json"

    if args.technique_type == "rag":
        output_file_path = os.path.join(args.output_folder, response_path)
        rag_manager = RAGManager(
            data_path="data/locomo/locomo10_rag.json", chunk_size=args.chunk_size, k=args.num_chunks
        )
        rag_manager.process_all_conversations(output_file_path)
        """Generate response files"""
        generate_response_file(output_file_path)


if __name__ == "__main__":
    start = time.time()
    main()
    end = time.time()
    print(f"Execution time is:{end - start}")
