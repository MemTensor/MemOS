import argparse
import asyncio
import json
import os
import re

from collections import Counter
from typing import Any

import pandas as pd

from dotenv import load_dotenv
from openai import OpenAI
from tqdm.asyncio import tqdm


load_dotenv()

API_KEY = os.getenv("OPENAI_API_KEY")
API_URL = os.getenv("OPENAI_BASE_URL")


async def call_gpt4o_mini_async(client: OpenAI, prompt: str) -> str:
    messages = [{"role": "user", "content": prompt}]

    try:
        response = await asyncio.to_thread(
            client.chat.completions.create,
            model="gpt-4o-mini",
            messages=messages,
            temperature=0,
            max_tokens=500,
            timeout=30.0,
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"API call failed: {e!s}")
        return ""


def parse_xml_response(response: str, tag: str) -> str:
    match = re.search(f"<{tag}>(.*?)</{tag}>", response, re.DOTALL)
    return match.group(1).strip() if match else ""


async def evaluate_violate_preference_async(
    client: OpenAI, preference: str, question: str, response: str
) -> dict[str, str]:
    prompt = f"""You will analyze a conversation between a user and an assistant, focusing on whether the assistant's response violates the user's stated preference.
Evaluate the response based on these criteria:

Answer "Yes" if:

1. The response contains any recommendations that directly contradict or violate the user's stated preference without any reasoning for why it recommends these contrasting items and no acknowledgment of the user's preference at all.

Answer "No" if:

1. The response respects the user's stated preference.
2. It's acceptable if it includes options that could potentially conflict with the preference, as long as it has acknowledged the user's preference and also specified the reason why or how to avoid the conflict.
3. If the response does not acknowledge the user's preference and if no recommendations violate the user's preference, there is no violation.

Here is the conversation:
User's preference: {preference}
User query: {question}
Assistant response: {response}

Examine the response meticulously and answer. Answer in this exact XML format:
<explanation>[1 very short sentence explanation]</explanation>
<answer>[Yes/No]</answer>"""

    api_response = await call_gpt4o_mini_async(client, prompt)
    return {
        "explanation": parse_xml_response(api_response, "explanation"),
        "answer": parse_xml_response(api_response, "answer"),
    }


async def evaluate_acknowledge_preference_async(
    client: OpenAI, question: str, response: str
) -> dict[str, str]:
    prompt = f"""You will analyze a conversation between a user and an assistant, focusing on whether the assistant acknowledges any user preference in answering the user's query.

Evaluate the response based on these stringent criteria:

1. Check if the response explicitly or implicitly mentions or references a user preference. 2. The content of the preference is irrelevant for this check; only its presence matters.

Answer "Yes" if:

1. The response explicitly mentions or refers to a user preference in answering the user's question. Examples include: "Based on your previous preference for xxxx"; "Based on your previous preference, I would suggest you xxxx"; "Since you mentioned you prefer/dislike xxxx"; "Since you are a xxxx"; "I will recommend the following given your preference for xxx", etc. You should extract the "xxxx" in your answer. If it only says "Based on our previous conversation, I recommend..." and does not explicitly mention any preference, you should answer 'No'.
2. The response assumes the user preference in answering the user's question implicitly. For example, when the user asks 'Can you recommend me cars to drive?', if the response is 'Based on your preference, I will recommend non-EV cars, ...', then this indicates the assistant assumes that the user's preference is a dislike of EV cars, and you should answer 'Yes'.

Answer "No" if the response does not mention or refer to any user preference explicitly or implicitly. If you cannot extract the sentence stating what the preference is, answer 'No'.

Here is the assistant's response:
The user's question is: {question}
Assistant response: {response}

Examine the response meticulously and answer. Please answer in this exact XML format without any additional text:
<preference>[quote of the sentence that acknowledges/mentions what the preference is; leave it blank if there is none]</preference>
<answer>[Yes/No]</answer>"""
    api_response = await call_gpt4o_mini_async(client, prompt)
    return {
        "preference_mention": parse_xml_response(api_response, "preference"),
        "answer": parse_xml_response(api_response, "answer"),
    }


async def evaluate_hallucinate_preference_async(
    client: OpenAI, preference: str, restatement: str
) -> dict[str, str]:
    if not restatement.strip():
        return {"explanation": "No restatement provided by assistant", "answer": "No"}
    prompt = f"""You will analyze a conversation between a user and an assistant, focusing on whether the assistant's restatement of the user's stated preference is the same preference. Evaluate the response based on these stringent criteria to answer if the assistant has hallucinated the preference or not:

Answer "Yes" if:

1. The assistant's restatement differs from the original preference in meaning or intent.
2. The assistant's restatement contradicts the original preference.
3. The assistant's restatement is not related or irrelevant to the original preference.

Answer "No" if has not hallucinated:

1. The assistant's restatement matches the original preference.
2. The assistant's restatement is a minor paraphrase that fully preserves the meaning and intent of the original preference.
3. The restatement is just empty, no hallucination.

Here is the information:
Original user preference: "{preference}"
Assistant's restatement: "{restatement}"
Examine the original preference and the assistant's restatement meticulously and answer. Please answer in this exact XML format without any other additional text:
<explanation>[1 short sentence explanation]</explanation>
<answer>[Yes/No]</answer>"""

    api_response = await call_gpt4o_mini_async(client, prompt)
    return {
        "explanation": parse_xml_response(api_response, "explanation"),
        "answer": parse_xml_response(api_response, "answer"),
    }


async def evaluate_helpful_response_async(
    client: OpenAI, question: str, response: str
) -> dict[str, str]:
    prompt = f"""You will analyze a conversation between a user and an assistant, focusing on whether the assistant provides any substantive response to the user's query.
Evaluate the response based on these stringent criteria:

Answer "Yes" if any of the following:

1. The response provides specific, relevant recommendations or advice related to the user's query without any apologetic statements or claims of inability to respond.
2. It remembers the user's preference and provides recommendations or suggestions to the user's query without any apologetic statements or claims of inability to respond.

Answer "No" if any of the following:

1. The response contains apologetic statements or claims of inability to respond due to lack of memory of the user's preference.
2. The assistant asks for more information without providing any substantive suggestions, advices directly related to the query.
3. The response doesn't address the user's query.
4. Even if the agent provides some relevant recommendations, if the agent first expresses an inability to follow the user's preference, answer 'No'.

Examples of unhelpful responses: (Answer: No):

"Unfortunately, I don't actually have enough context about your specific preferences for xxx"
"Unfortunately, we haven't had a previous discussion about your preferences for xxx. Could you let me know your preference for xxx?"
"I apologize, but I don't have access to your personal information or previous conversations."
"I'm sorry, but I can't provide a specific answer without more details."

Here is the conversation:
User query: {question}
Assistant response: {response}

Examine the response meticulously and answer. Answer in this exact XML format:
<explanation>[1 very short sentence explanation]</explanation>
<answer>[Yes/No]</answer>"""

    api_response = await call_gpt4o_mini_async(client, prompt)
    return {
        "explanation": parse_xml_response(api_response, "explanation"),
        "answer": parse_xml_response(api_response, "answer"),
    }


def classify_error_type(evaluation_results: dict[str, Any]) -> str:
    violate = evaluation_results["violate_preference"]["answer"]
    acknowledge = evaluation_results["acknowledge_preference"]["answer"]
    hallucinate = evaluation_results["hallucinate_preference"]["answer"]
    helpful = evaluation_results["helpful_response"]["answer"]

    if violate == "Yes" and acknowledge == "No" and helpful == "Yes":
        return "Preference-Unaware Violation"
    elif violate == "Yes" and acknowledge == "Yes" and hallucinate == "Yes" and helpful == "Yes":
        return "Preference Hallucination Violation"
    elif violate == "Yes" and acknowledge == "Yes" and hallucinate == "No" and helpful == "Yes":
        return "Inconsistency Violation"
    elif violate == "No" and helpful == "No":
        return "Unhelpful Response"
    else:
        return "Personalized Response"


async def process_line(line: str, client: OpenAI, semaphore: asyncio.Semaphore) -> dict[str, Any]:
    async with semaphore:
        data = json.loads(line.strip())
        preference = data["preference"]
        response = data["response"]
        question = data["question"]
        eval2 = await evaluate_acknowledge_preference_async(client, question, response)

        tasks = [
            evaluate_violate_preference_async(client, preference, question, response),
            evaluate_hallucinate_preference_async(client, preference, eval2["preference_mention"]),
            evaluate_helpful_response_async(client, question, response),
        ]
        eval1, eval3, eval4 = await asyncio.gather(*tasks)

        evaluations = {
            "violate_preference": eval1,
            "acknowledge_preference": eval2,
            "hallucinate_preference": eval3,
            "helpful_response": eval4,
        }

        result = {
            "original_data": data,
            "evaluations": evaluations,
            "error_type": classify_error_type(evaluations),
            "metrics": data.get("metrics", {}),
        }
        return result


def log_summary(error_counter: Counter, total_samples: int) -> dict[str, dict[str, float]]:
    summary_data = {}
    print("\n--- Error Type Summary ---")

    if total_samples == 0:
        print("No samples were processed.")
        print("--------------------------")
        return summary_data

    print(f"Total samples processed: {total_samples}")
    sorted_errors = sorted(error_counter.items(), key=lambda item: item[1], reverse=True)

    for error_type, count in sorted_errors:
        percentage = (count / total_samples) * 100
        summary_data[error_type] = {"count": count, "percentage": percentage}
        print(f"- {error_type}: {count} ({percentage:.2f}%)")

    print("--------------------------")
    print("\nProcessing complete.")

    return summary_data


def generate_excel_summary(
    summary_results: dict[str, dict[str, float]],
    avg_search_time: float,
    avg_context_tokens: float,
    avg_add_time: float,
    output_excel_file: str,
    model_name: str = "gpt-4o-mini",
):
    print(f"Generating Excel summary at {output_excel_file}...")

    def get_pct(key):
        return summary_results.get(key, {}).get("percentage", 0)

    unaware_pct = get_pct("Preference-Unaware Violation")
    hallucination_pct = get_pct("Preference Hallucination Violation")
    inconsistency_pct = get_pct("Inconsistency Violation")
    unhelpful_pct = get_pct("Unhelpful Response")
    personalized_pct = get_pct("Personalized Response")

    data = {
        "Model": [model_name],
        "Preference-Unaware\n没有意识到偏好": [unaware_pct / 100],
        "Preference-Hallucination\n编造偏好": [hallucination_pct / 100],
        "Inconsistency\n意识到偏好但给出了不一致的回答": [inconsistency_pct / 100],
        "Unhelpful Response\n没帮助的回答": [unhelpful_pct / 100],
        "Personalized Response\n个性化回答": [personalized_pct / 100],
        "context token": [avg_context_tokens],
        "Time添加": [f"{avg_add_time:.2f}s"],
        "Time搜索": [f"{avg_search_time:.2f}s"],
    }

    df = pd.DataFrame(data)

    with pd.ExcelWriter(output_excel_file, engine="xlsxwriter") as writer:
        df.to_excel(writer, index=False, sheet_name="Summary")

        workbook = writer.book
        worksheet = writer.sheets["Summary"]

        pct_format = workbook.add_format({"num_format": "0.0%"})
        float_format = workbook.add_format({"num_format": "0.00"})
        wrap_format = workbook.add_format({"text_wrap": True, "align": "center", "valign": "top"})

        worksheet.set_column("B:F", 18, pct_format)
        worksheet.set_column("G:G", 12, float_format)
        worksheet.set_column("H:I", 15)
        worksheet.set_column("A:I", None, wrap_format)
        worksheet.set_row(0, 45)
        bold_pct_format = workbook.add_format({"num_format": "0.0%", "bold": True})
        worksheet.set_column("F:F", 18, bold_pct_format)

    print(f"Successfully saved summary to {output_excel_file}")


async def main(concurrency_limit: int, input_file: str, output_file: str, output_excel_file: str):
    semaphore = asyncio.Semaphore(concurrency_limit)
    error_counter = Counter()

    total_search_time = 0
    total_context_tokens = 0
    valid_metric_samples = 0
    total_add_time = 0

    print(f"Starting evaluation with a concurrency limit of {concurrency_limit}...")
    print(f"Input file: {input_file}")
    print(f"Output JSONL: {output_file}")
    print(f"Output Excel: {output_excel_file}")

    client = OpenAI(api_key=API_KEY, base_url=API_URL)

    try:
        with open(input_file, encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(f"Error: Input file not found at '{input_file}'")
        return

    if not lines:
        print("Error: Input file is empty.")
        return

    tasks = [process_line(line, client, semaphore) for line in lines]

    with open(output_file, "w", encoding="utf-8") as outfile:
        pbar = tqdm(
            asyncio.as_completed(tasks),
            total=len(tasks),
            desc="Processing samples concurrently",
            unit="sample",
        )
        for future in pbar:
            try:
                result = await future
                outfile.write(json.dumps(result, ensure_ascii=False) + "\n")

                error_type = result["error_type"]
                error_counter[error_type] += 1

                metrics = result.get("metrics", {})
                search_time = metrics.get("search_memories_duration_seconds")
                context_tokens = metrics.get("memory_tokens_used")
                add_time = metrics.get("add_memories_duration_seconds")

                all_metrics_valid = (
                    search_time is not None and add_time is not None and context_tokens is not None
                )

                if all_metrics_valid:
                    total_search_time += float(search_time)
                    total_context_tokens += int(context_tokens)
                    total_add_time += float(add_time)
                    valid_metric_samples += 1

                pbar.set_postfix({"Latest Type": error_type})

            except Exception as e:
                print(f"An error occurred while processing a line: {e}")

    total_samples = len(lines)
    summary_results = log_summary(error_counter, total_samples)

    avg_search_time = (total_search_time / valid_metric_samples) if valid_metric_samples > 0 else 0
    avg_add_time = (total_add_time / valid_metric_samples) if valid_metric_samples > 0 else 0
    avg_context_tokens = (
        (total_context_tokens / valid_metric_samples) if valid_metric_samples > 0 else 0
    )

    try:
        generate_excel_summary(
            summary_results,
            avg_search_time,
            avg_context_tokens,
            avg_add_time,
            output_excel_file,
        )
    except Exception as e:
        print(f"\nFailed to generate Excel file: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate assistant responses from a JSONL file.")

    parser.add_argument("--input", type=str, required=True, help="Path to the input JSONL file.")

    parser.add_argument(
        "--concurrency-limit",
        type=int,
        default=10,
        help="The maximum number of concurrent API calls.",
    )

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
            "zep",
        ],
        default="memos-api",
        help="Which library to use (used in 'add' mode).",
    )

    args = parser.parse_args()

    input_path = args.input
    output_dir = os.path.dirname(input_path)

    output_jsonl_path = os.path.join(output_dir, f"eval_pref_{args.lib}.jsonl")
    output_excel_path = os.path.join(output_dir, f"eval_pref_{args.lib}_summary.xlsx")

    asyncio.run(
        main(
            concurrency_limit=args.concurrency_limit,
            input_file=input_path,
            output_file=output_jsonl_path,
            output_excel_file=output_excel_path,
        )
    )
