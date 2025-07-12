import argparse
import json
import os
import time

from collections import defaultdict
from multiprocessing.dummy import Pool

from dotenv import load_dotenv
from openai import OpenAI
from tenacity import retry, stop_after_attempt, wait_random_exponential
from tqdm import tqdm


load_dotenv()

# Retry policy constants
WAIT_MIN = 5  # minimum backoff delay in seconds
WAIT_MAX = 30  # maximum backoff delay in seconds
MAX_TRIES = 10  # maximum number of retry attempts

WORKERS = 5  # number of parallel worker processes

ANSWER_PROMPT = """
    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

    # CONTEXT:
    You have access to memories from a conversation. These memories contain
    timestamped information that may be relevant to answering the question.

    # INSTRUCTIONS:
    1. Carefully analyze all provided memories
    2. Pay special attention to the timestamps to determine the answer
    3. If the question asks about a specific event or fact, look for direct evidence in the memories
    4. If the memories contain contradictory information, prioritize the most recent memory
    5. If there is a question about time references (like "last year", "two months ago", etc.),
       calculate the actual date based on the memory timestamp. For example, if a memory from
       4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
    6. Always convert relative time references to specific dates, months, or years. For example,
       convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory
       timestamp. Ignore the reference while answering the question.
    7. Focus only on the content of the memories. Do not confuse character
       names mentioned in memories with the actual users who created those memories.
    8. The answer should be less than 5-6 words.

    # APPROACH (Think step by step):
    1. First, examine all memories that contain information related to the question
    2. Examine the timestamps and content of these memories carefully
    3. Look for explicit mentions of dates, times, locations, or events that answer the question
    4. If the answer requires calculation (e.g., converting relative time references), show your work
    5. Formulate a precise, concise answer based solely on the evidence in the memories
    6. Double-check that your answer directly addresses the question asked
    7. Ensure your final answer is specific and avoids vague time references

    Memories:

    {context}

    Question: {question}
    Answer:
    """


class OpenAIPredict:
    def __init__(self, model="gpt-4o-mini"):
        self.model = model
        self.openai_client = OpenAI(
            api_key=os.getenv("OPENAI_API_KEY"), base_url=os.getenv("OPENAI_BASE_URL")
        )
        self.results = defaultdict(list)

    def search_memory(self, idx):
        with open(f"openai_memory/{idx}.txt", encoding="utf-8") as file:
            memories = file.read().strip().replace("\n\n", "\n")

        return memories, 0

    def process_question(self, val, idx):
        question = val.get("question", "")
        answer = val.get("answer", "")
        category = val.get("category", -1)

        response, search_memory_time, response_time, context = self.answer_question(idx, question)

        result = {
            "question": question,
            "answer": response,
            "category": category,
            "golden_answer": answer,
            "search_context": context,
            "response_duration_ms": response_time,
            "search_duration_ms": search_memory_time,
        }

        return result

    @retry(
        wait=wait_random_exponential(min=WAIT_MIN, max=WAIT_MAX),
        stop=stop_after_attempt(MAX_TRIES),
        reraise=True,
    )
    def answer_question(self, idx, question):
        memories, search_memory_time = self.search_memory(idx)

        answer_prompt = ANSWER_PROMPT.format(context=memories, question=question)

        t1 = time.time()
        response = self.openai_client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": answer_prompt}],
            temperature=0.0,
        )
        t2 = time.time()
        response_time = (t2 - t1) * 1000
        return response.choices[0].message.content, search_memory_time, response_time, memories

    def process_data_file(self, file_path, output_file_path):
        with open(file_path, encoding="utf-8") as f:
            data = json.load(f)

        # Function to process each conversation
        def process_conversation(item):
            idx, conversation = item
            results_for_conversation = []

            # Process each question in the conversation
            for question_item in tqdm(
                conversation["qa"], desc=f"Processing questions for conversation {idx}", leave=False
            ):
                if int(question_item.get("category", "")) == 5:
                    continue
                result = self.process_question(question_item, idx)
                results_for_conversation.append(result)

            return idx, results_for_conversation

        # Use multiprocessing to process the conversations in parallel
        with Pool(processes=WORKERS) as pool:
            results = list(
                tqdm(
                    pool.imap(process_conversation, list(enumerate(data))),
                    total=len(data),
                    desc="Processing conversations",
                )
            )

        # Reorganize results and store them in self.results
        for idx, results_for_conversation in results:
            self.results[f"locomo_exp_user_{idx}"] = results_for_conversation

        # Save results to output file
        with open(output_file_path, "w") as f:
            json.dump(self.results, f, indent=4)


def main(version):
    os.makedirs(f"results/locomo/openai-{version}/", exist_ok=True)
    output_file_path = f"results/locomo/openai-{version}/openai_locomo_responses.json"
    openai_predict = OpenAIPredict()
    openai_predict.process_data_file("data/locomo/locomo10.json", output_file_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version",
        type=str,
        default="default",
        help="Version identifier for loading results (e.g., 1010)",
    )
    args = parser.parse_args()
    version = args.version
    main(version)
