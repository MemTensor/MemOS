'''
Modify the code from the mem0 project, Original file link
https://github.com/mem0ai/mem0/blob/main/evaluation/src/rag.py
'''

import json
import os
import numpy as np
import time
from collections import defaultdict

import numpy as np
import tiktoken
import argparse

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

TECHNIQUES = ["mem0", "rag", "langmem", "zep", "openai"]
METHODS = ["add", "search"]

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
                # return response.choices[0].message.content.strip(), t2 - t1
                if response and response.choices:
                    content = response.choices[0].message.content
                    if content is not None:
                        return content.strip(), t2 - t1
                    else:
                        return "No content returned", t2 - t1
                        print(f"❎ No content returned!")
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
            cleaned_chat_history += f"{c['timestamp']} | {c['speaker']}: " f"{c['text']}\n"

        return cleaned_chat_history

    def calculate_embedding(self, document):
        response = self.client.embeddings.create(model=os.getenv("EMBEDDING_MODEL"), input=document)
        return response.data[0].embedding

    def calculate_similarity(self, embedding1, embedding2):
        return np.dot(embedding1, embedding2) / (np.linalg.norm(embedding1) * np.linalg.norm(embedding2))

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
        similarities = [self.calculate_similarity(query_embedding, embedding) for embedding in embeddings]

        # Get indices of top-k most similar chunks
        if k == 1:
            # Original behavior - just get the most similar chunk
            top_indices = [np.argmax(similarities)]
        else:
            # Get indices of top-k chunks
            top_indices = np.argsort(similarities)[-k:][::-1]

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
        with open(self.data_path, "r") as f:
            data = json.load(f)

        FINAL_RESULTS = defaultdict(list)
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

                FINAL_RESULTS[key].append(
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
                    json.dump(FINAL_RESULTS, f, indent=4)

        # Save results
        with open(output_file_path, "w+") as f:
            json.dump(FINAL_RESULTS, f, indent=4)


class Experiment:
    def __init__(self, technique_type, chunk_size):
        self.technique_type = technique_type
        self.chunk_size = chunk_size

    def run(self):
        print(f"Running experiment with technique: {self.technique_type}, chunk size: {self.chunk_size}")


def main():

    parser = argparse.ArgumentParser(description="Run memory experiments")
    parser.add_argument("--technique_type", choices=TECHNIQUES, default="rag", help="Memory technique to use")
    parser.add_argument("--chunk_size", type=int, default=500, help="Chunk size for processing")
    parser.add_argument("--output_folder", type=str, default="results/", help="Output path for results")
    parser.add_argument("--top_k", type=int, default=30, help="Number of top memories to retrieve")
    parser.add_argument("--num_chunks", type=int, default=2, help="Number of chunks to process")

    args = parser.parse_args()

    if args.technique_type == "rag":
        output_file_path = os.path.join(args.output_folder, f"rag_results_{args.chunk_size}_k{args.num_chunks}.json")
        rag_manager = RAGManager(data_path="data/locomo/locomo10_rag.json", chunk_size=args.chunk_size, k=args.num_chunks)
        rag_manager.process_all_conversations(output_file_path)

if __name__ =="__main__":
    start = time.time()
    main()
    end = time.time()
    print(f"Execution time is:{end - start}")
