import argparse
import json
import os
import sys

from concurrent.futures import ThreadPoolExecutor, as_completed
from time import time

from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)


# Dataset to prompt mapping (from LongBench config)
DATASET_PROMPTS = {
    "narrativeqa": "You are given a story, which can be either a novel or a movie script, and a question. Answer the question as concisely as you can, using a single phrase if possible. Do not provide any explanation.\n\nStory: {context}\n\nNow, answer the question based on the story as concisely as you can, using a single phrase if possible. Do not provide any explanation.\n\nQuestion: {input}\n\nAnswer:",
    "qasper": 'You are given a scientific article and a question. Answer the question as concisely as you can, using a single phrase or sentence if possible. If the question cannot be answered based on the information in the article, write "unanswerable". If the question is a yes/no question, answer "yes", "no", or "unanswerable". Do not provide any explanation.\n\nArticle: {context}\n\n Answer the question based on the above article as concisely as you can, using a single phrase or sentence if possible. If the question cannot be answered based on the information in the article, write "unanswerable". If the question is a yes/no question, answer "yes", "no", or "unanswerable". Do not provide any explanation.\n\nQuestion: {input}\n\nAnswer:',
    "multifieldqa_en": "Read the following text and answer briefly.\n\n{context}\n\nNow, answer the following question based on the above text, only give me the answer and do not output any other words.\n\nQuestion: {input}\nAnswer:",
    "multifieldqa_zh": "阅读以下文字并用中文简短回答：\n\n{context}\n\n现在请基于上面的文章回答下面的问题，只告诉我答案，不要输出任何其他字词。\n\n问题：{input}\n回答：",
    "hotpotqa": "Answer the question based on the given passages. Only give me the answer and do not output any other words.\n\nThe following are given passages.\n{context}\n\nAnswer the question based on the given passages. Only give me the answer and do not output any other words.\n\nQuestion: {input}\nAnswer:",
    "2wikimqa": "Answer the question based on the given passages. Only give me the answer and do not output any other words.\n\nThe following are given passages.\n{context}\n\nAnswer the question based on the given passages. Only give me the answer and do not output any other words.\n\nQuestion: {input}\nAnswer:",
    "musique": "Answer the question based on the given passages. Only give me the answer and do not output any other words.\n\nThe following are given passages.\n{context}\n\nAnswer the question based on the given passages. Only give me the answer and do not output any other words.\n\nQuestion: {input}\nAnswer:",
    "dureader": "请基于给定的文章回答下述问题。\n\n文章：{context}\n\n请基于上述文章回答下面的问题。\n\n问题：{input}\n回答：",
    "gov_report": "You are given a report by a government agency. Write a one-page summary of the report.\n\nReport:\n{context}\n\nNow, write a one-page summary of the report.\n\nSummary:",
    "qmsum": "You are given a meeting transcript and a query containing a question or instruction. Answer the query in one or more sentences.\n\nTranscript:\n{context}\n\nNow, answer the query based on the above meeting transcript in one or more sentences.\n\nQuery: {input}\nAnswer:",
    "multi_news": "You are given several news passages. Write a one-page summary of all news. \n\nNews:\n{context}\n\nNow, write a one-page summary of all the news.\n\nSummary:",
    "vcsum": "下面有一段会议记录，请你阅读后，写一段总结，总结会议的内容。\n会议记录：\n{context}\n\n会议总结：",
    "trec": "Please determine the type of the question below. Here are some examples of questions.\n\n{context}\n{input}",
    "triviaqa": "Answer the question based on the given passage. Only give me the answer and do not output any other words. The following are some examples.\n\n{context}\n\n{input}",
    "samsum": "Summarize the dialogue into a few short sentences. The following are some examples.\n\n{context}\n\n{input}",
    "lsht": "请判断给定新闻的类别，下面是一些例子。\n\n{context}\n{input}",
    "passage_count": "There are some paragraphs below sourced from Wikipedia. Some of them may be duplicates. Please carefully read these paragraphs and determine how many unique paragraphs there are after removing duplicates. In other words, how many non-repeating paragraphs are there in total?\n\n{context}\n\nPlease enter the final count of unique paragraphs after removing duplicates. The output format should only contain the number, such as 1, 2, 3, and so on.\n\nThe final answer is: ",
    "passage_retrieval_en": 'Here are 30 paragraphs from Wikipedia, along with an abstract. Please determine which paragraph the abstract is from.\n\n{context}\n\nThe following is an abstract.\n\n{input}\n\nPlease enter the number of the paragraph that the abstract is from. The answer format must be like "Paragraph 1", "Paragraph 2", etc.\n\nThe answer is: ',
    "passage_retrieval_zh": '以下是若干段落文字，以及其中一个段落的摘要。请确定给定的摘要出自哪一段。\n\n{context}\n\n下面是一个摘要\n\n{input}\n\n请输入摘要所属段落的编号。答案格式必须是"段落1"，"段落2"等格式\n\n答案是：',
    "lcc": "Please complete the code given below. \n{context}Next line of code:\n",
    "repobench-p": "Please complete the code given below. \n{context}{input}Next line of code:\n",
}


def generate_response(llm_client, dataset_name, context, input_text):
    """Generate response using LLM."""
    # Get prompt template for dataset
    prompt_template = DATASET_PROMPTS.get(dataset_name, "{context}\n\nQuestion: {input}\nAnswer:")

    # Format prompt
    if "{input}" in prompt_template:
        prompt = prompt_template.format(context=context, input=input_text)
    else:
        # Some prompts don't have {input} placeholder (like gov_report, vcsum)
        prompt = prompt_template.format(context=context)

    try:
        response = llm_client.chat.completions.create(
            model=os.getenv("CHAT_MODEL"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
        )
        result = response.choices[0].message.content or ""
        return result
    except Exception as e:
        print(f"Error generating response: {e}")
        return ""


def process_sample(search_result, llm_client):
    """Process a single sample: generate answer."""
    start = time()

    dataset_name = search_result.get("dataset")
    context = search_result.get("context", "")
    input_text = search_result.get("input", "")

    # Generate answer
    answer = generate_response(llm_client, dataset_name, context, input_text)

    response_duration_ms = (time() - start) * 1000

    return {
        "dataset": dataset_name,
        "sample_idx": search_result.get("sample_idx"),
        "input": input_text,
        "answer": answer,
        "golden_answer": search_result.get("answers", []),
        "all_classes": search_result.get("all_classes"),
        "length": search_result.get("length", 0),
        "search_context": context,
        "response_duration_ms": response_duration_ms,
        "search_duration_ms": search_result.get("search_duration_ms", 0),
    }


def main(frame, version="default", num_workers=10):
    """Main response generation function."""
    load_dotenv()

    print("\n" + "=" * 80)
    print(f"🚀 LONGBENCH RESPONSE GENERATION - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Load search results
    search_path = f"results/longbench/{frame}-{version}/{frame}_longbench_search_results.json"
    if not os.path.exists(search_path):
        print(f"❌ Search results not found: {search_path}")
        print("Please run longbench_search.py first")
        return

    with open(search_path, encoding="utf-8") as f:
        search_results = json.load(f)

    # Initialize LLM client
    llm_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"),
        base_url=os.getenv("CHAT_MODEL_BASE_URL"),
    )
    print(f"🔌 Using OpenAI client with model: {os.getenv('CHAT_MODEL')}")

    # Process all samples
    all_responses = []
    for dataset_name, samples in search_results.items():
        print(f"\nProcessing {len(samples)} samples from {dataset_name}...")

        with ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = [executor.submit(process_sample, sample, llm_client) for sample in samples]

            for future in tqdm(
                as_completed(futures),
                total=len(futures),
                desc=f"Generating responses for {dataset_name}",
            ):
                result = future.result()
                if result:
                    all_responses.append(result)

    # Save responses
    output_path = f"results/longbench/{frame}-{version}/{frame}_longbench_responses.json"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Group by dataset
    responses_by_dataset = {}
    for response in all_responses:
        dataset = response["dataset"]
        if dataset not in responses_by_dataset:
            responses_by_dataset[dataset] = []
        responses_by_dataset[dataset].append(response)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(responses_by_dataset, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 80}")
    print(f"✅ RESPONSE GENERATION COMPLETE: Results saved to {output_path}".center(80))
    print(f"{'=' * 80}\n")


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
        help="Version identifier for loading results",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=10,
        help="Number of parallel workers",
    )
    args = parser.parse_args()

    main(args.lib, args.version, args.workers)
