import base64
import json
import mimetypes
import os
import re
import sys
import time
import traceback

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

import openai

from dotenv import load_dotenv
from tqdm import tqdm

from evaluation.scripts.utils.eval_score import eval_acc_and_f1, eval_score, show_results
from evaluation.scripts.utils.extract_answer import extract_answer
from evaluation.scripts.utils.prompts import MMLONGBENCH_ANSWER_PROMPT
from memos.log import get_logger


logger = get_logger(__name__)


load_dotenv()

# Initialize OpenAI Client
oai_client = openai.Client(
    api_key=os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    base_url=os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
)


def _encode_image_to_data_url(image_path: str) -> str | None:
    """Encode local image file to base64 data URL for OpenAI-compatible image messages.

    Returns a data URL like: data:image/jpeg;base64,<...>
    """
    try:
        mime, _ = mimetypes.guess_type(image_path)
        if not mime:
            # default to jpeg
            mime = "image/jpeg"
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception as e:
        logger.warning(f"Failed to encode image '{image_path}' to data URL: {e}")
        return None


# @lru_cache(maxsize=1)
def build_images_index() -> dict[str, str]:
    """Scan `./ppt_test_result` recursively and index images by filename.

    New structure example:
    ./ppt_test_result/<pdf-name>/extracted/file_*/<pdf-name>/auto/images/*.{png,jpg,jpeg,webp,gif}

    Also compatible with previous layouts. Returns mapping:
    basename (e.g. img_123.jpg) -> absolute path
    """
    base_dir = Path("/Users/tianxingshi/Desktop/lcy/ppt_test_result")
    index: dict[str, str] = {}
    if not base_dir.exists():
        return index

    # Recursively find any `auto/images` directories under ppt_test_result
    for images_dir in base_dir.rglob("auto/images"):
        if images_dir.is_dir():
            for img_file in images_dir.iterdir():
                if img_file.is_file():
                    index[img_file.name] = str(img_file.resolve())
    return index


index_dict = build_images_index()


def get_images(sources: list) -> list[str]:
    """Extract image absolute paths from metadata sources.

    Supports patterns like: ![](images/<hash>.jpg) or any 'images/...jpg' substring.
    Falls back to scanning the ppt_test_result index to resolve basenames.
    """
    if not sources:
        return []

    # Ensure index exists

    found: list[str] = []

    md_img_pattern = re.compile(r"\[Image: images/\s*(.+?)\s*-")
    images_substr_pattern = re.compile(r"images/[^\s)]+\.(?:png|jpg|jpeg|webp)", re.IGNORECASE)
    for src in sources:
        if not src:
            continue
        # 1) markdown image syntax
        for m in md_img_pattern.findall(src):
            candidate = m.strip()
            # if it's a relative like 'images/xxx.jpg', resolve via index
            basename = os.path.basename(candidate)
            if basename in index_dict:
                found.append(index_dict[basename])
            else:
                # try direct path (absolute or relative)
                p = Path(candidate)
                if not p.is_absolute():
                    p = Path.cwd() / p
                if p.exists():
                    found.append(str(p.resolve()))

        # 2) any 'images/xxx.jpg' substring
        for m in images_substr_pattern.findall(src):
            candidate = m.strip()
            basename = os.path.basename(candidate)
            if basename in index_dict:
                found.append(index_dict[basename])
            else:
                p = Path(candidate)
                if not p.is_absolute():
                    p = Path.cwd() / p
                if p.exists():
                    found.append(str(p.resolve()))

    # Deduplicate preserving order
    dedup: list[str] = []
    seen = set()
    for path in found:
        if path not in seen:
            dedup.append(path)
            seen.add(path)
    return dedup


def add_images_context(
    current_messages: list[dict[str, Any]], images: list[str]
) -> list[dict[str, Any]]:
    """Append images in OpenAI-compatible multi-part format and ensure message structure.

    - Deduplicates image paths.
    - Ensures a system message exists with a concise CN vision instruction.
    - Ensures the last user message has multi-part content: [text, image_url...].
    - Uses base64 data URLs. Limits to 6 images.
    - In-place modification of `current_messages`.
    """
    if not images:
        return current_messages

    # Deduplicate images while preserving order
    unique_images: list[str] = []
    seen_paths: set[str] = set()
    for p in images:
        if p not in seen_paths:
            unique_images.append(p)
            seen_paths.add(p)

    # Locate or create the last user message
    user_idx = None
    for i in range(len(current_messages) - 1, -1, -1):
        if current_messages[i].get("role") == "user":
            user_idx = i
            break

    user_msg = current_messages[user_idx]
    orig_content = user_msg.get("content", "")

    # Normalize user content to multi-part format using original query as text (no fallback)
    content_parts: list[dict[str, Any]]
    if isinstance(orig_content, str):
        content_parts = [{"type": "text", "text": orig_content}]
    elif isinstance(orig_content, list):
        content_parts = orig_content
    else:
        content_parts = [{"type": "text", "text": str(orig_content)}]

    # 5) Append up to 3 images as data URLs
    limit = 6
    count = 0

    for img_path in unique_images:
        if count >= limit:
            break
        data_url = _encode_image_to_data_url(img_path)
        if data_url:
            content_parts.append({"type": "image_url", "image_url": {"url": data_url}})
            count += 1
    user_msg["content"] = content_parts
    current_messages[user_idx] = user_msg
    logger.info(
        f"Attached {count} images to user message (deduplicated from {len(images)}), {json.dumps(current_messages, ensure_ascii=False, indent=2)}"
    )
    return current_messages


def multimodal_answer(
    oai_client,
    memories: list[str],
    question: str,
    top_k: int = 15,
    sources: list | None = None,
) -> tuple[str, int | None]:
    sources_texts: list[str] = []
    for source in sources[:top_k]:
        source = source[0]
        content = source.get("content") if isinstance(source, dict) else str(source)
        if content:
            sources_texts.append(content)

    image_paths = get_images(sources_texts)
    system_prompt = MMLONGBENCH_ANSWER_PROMPT.format(
        memories="\n\n".join(memories[:top_k]), question=question
    )
    messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": question}]
    messages = add_images_context(messages, image_paths)
    for _, msg in enumerate(messages):
        if msg.get("role") == "user" and isinstance(msg.get("content"), list):
            img_count = sum(1 for p in msg["content"] if p.get("type") == "image_url")
            print(
                f"DEBUG: user message has {len(memories[:top_k])} memories, {img_count} images attached"
            )

    resp = oai_client.chat.completions.create(
        model=args.chat_model, messages=messages, temperature=0
    )
    return resp.choices[0].message.content or "", resp.usage.prompt_tokens


def process_single_item(item: dict, index: int, top_k: int = 20) -> dict:
    """Process a single evaluation item"""
    question = item["question"]
    memories = item.get("memories", [])
    sources = item.get("sources", [])
    if not memories:
        result = {
            "response": None,
            "extracted_res": None,
            "pred": None,
            "score": 0,
            "eval_success": False,
            "eval_error": "",
        }
    try:
        # Get model response
        response, prompt_tokens = multimodal_answer(oai_client, memories, question, top_k, sources)

        # Extract answer
        extracted_res = extract_answer(question, response)

        # Parse extracted answer
        try:
            pred_ans = (
                extracted_res.split("Answer format:")[0].split("Extracted answer:")[1].strip()
            )
        except Exception as e:
            print("extract_answer error**********", e)
            pred_ans = response.strip()

        # Calculate score
        score = eval_score(item.get("answer"), pred_ans, item.get("answer_format", "Str"))

        # Build result
        result = {
            "response": response,
            "extracted_res": extracted_res,
            "pred": pred_ans,
            "score": score,
            "prompt_tokens": prompt_tokens,
            "eval_success": True,
            "eval_error": None,
        }

    except Exception as e:
        traceback.print_exc()
        result = {
            "response": None,
            "extracted_res": None,
            "pred": None,
            "score": 0,
            "eval_success": False,
            "eval_error": str(e),
        }

    return {"index": index, "result": result}


def run_eval(
    questions_file: str | Path,
    output_file: str | Path | None = None,
    version_dir: str | Path | None = None,
    max_workers: int = 10,
    top_k: int = 20,
) -> None:
    """
    Run evaluation

    Args:
        version_dir: version directory
        questions_file: Input questions file path
        output_file: Output file path, overwrites input file if None
        max_workers: Number of concurrent workers
    """
    questions_file = Path(questions_file)
    output_file = questions_file if output_file is None else Path(output_file)

    # Read input data
    with open(questions_file, encoding="utf-8") as f:
        data = json.load(f)

    items = data["results"]
    total = len(items)
    print(f"[Info] Starting evaluation, total {total} items, concurrency: {max_workers}")

    # Concurrent processing
    results_map = {}
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(process_single_item, item, i, top_k): i for i, item in enumerate(items)
        }

        # Use tqdm to show progress bar
        with tqdm(
            total=total,
            desc="Evaluation Progress",
            unit="items",
            bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]",
        ) as pbar:
            for future in as_completed(futures):
                result_data = future.result()
                idx = result_data["index"]
                result = result_data["result"]
                results_map[idx] = result

                # Update progress bar, show current score
                score = result.get("score", 0)
                success = result.get("eval_success", False)
                status = f"score={score:.2f}" if success else "ERROR"
                pbar.set_postfix_str(status)
                pbar.update(1)

    # Write results to each item in original data
    for i, item in enumerate(items):
        if i in results_map:
            item.update(results_map[i])

    # Update summary info
    eval_duration = time.time() - start_time

    # Calculate evaluation statistics
    success_count = sum(1 for r in results_map.values() if r.get("eval_success", False))
    failed_count = total - success_count
    scores = [r.get("score", 0) for r in results_map.values() if r.get("eval_success", False)]
    prompt_tokens_list = [
        r.get("prompt_tokens")
        for r in results_map.values()
        if r.get("eval_success", False) and isinstance(r.get("prompt_tokens"), int)
    ]
    avg_prompt_tokens = (
        (sum(prompt_tokens_list) / len(prompt_tokens_list)) if prompt_tokens_list else 0
    )

    # Calculate acc and f1
    eval_results = [{**items[i], **results_map[i]} for i in range(len(items)) if i in results_map]
    acc, f1 = eval_acc_and_f1(eval_results)

    # Update data summary
    if "eval_summary" not in data:
        data["eval_summary"] = {}

    data["eval_summary"] = {
        "eval_duration_seconds": eval_duration,
        "total_samples": total,
        "success_count": success_count,
        "failed_count": failed_count,
        "accuracy": acc,
        "f1_score": f1,
        "avg_score": sum(scores) / len(scores) if scores else 0,
        "avg_prompt_tokens": avg_prompt_tokens,
        "max_workers": max_workers,
        "eval_timestamp": datetime.now().isoformat(),
    }

    # Save results to output file
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 60}")
    print("[Evaluation Finished]")
    print(f"  Total samples: {total}")
    print(f"  Success: {success_count}, Failed: {failed_count}")
    print(f"  Accuracy: {acc:.4f}")
    print(f"  F1 Score: {f1:.4f}")
    print(f"  Average Score: {data['eval_summary']['avg_score']:.4f}")
    print(f"  Average prompt_tokens: {data['eval_summary']['avg_prompt_tokens']:.2f}")
    print(f"  Duration: {eval_duration:.2f}s")
    print(f"  Results saved to: {output_file}")
    print(f"{'=' * 60}")

    # Generate detailed report
    report_path = version_dir / f"{args.lib}_eval_results.txt"
    show_results(eval_results, show_path=str(report_path))
    print(f"[Report] Detailed report saved to: {report_path}")

    # Save concise metrics file
    metrics_path = report_path.with_name(report_path.stem + "_metrics.json")

    metrics = {
        "accuracy": acc,
        "f1_score": f1,
        "avg_score": data["eval_summary"]["avg_score"],
        "avg_prompt_tokens": data["eval_summary"]["avg_prompt_tokens"],
        "total_samples": total,
        "success_count": success_count,
        "failed_count": failed_count,
        "eval_duration_seconds": eval_duration,
        "eval_timestamp": data["eval_summary"]["eval_timestamp"],
    }
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)
    print(f"[Metrics] Metrics saved to: {metrics_path}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="MMlongbench Evaluation Script")
    parser.add_argument("--lib", "-b", required=True, help="Product name to evaluate")
    parser.add_argument("--workers", "-w", type=int, default=20, help="Concurrent workers")
    parser.add_argument(
        "--top-k", "-k", type=int, default=20, help="Top K results to use (default: 20)"
    )
    parser.add_argument("--version-dir", "-v", default=None, help="Version directory name")
    parser.add_argument("--chat-model", "-m", default=None, help="chat model name")

    args = parser.parse_args()

    print("=" * 60)
    print("MMLongBench-doc Product Eval Tool")
    print("=" * 60)

    print("[Response model]: ", os.getenv("CHAT_MODEL"))

    base_dir = Path("evaluation/data/mmlongbench")
    version_dir = base_dir / args.version_dir
    input_filename = f"{args.lib}_search_results.json"
    input_path = version_dir / input_filename

    if not input_path.exists():
        print(f"Error: Input file not found: {input_path}")
        sys.exit(1)

    output_path = input_path

    print(f"[Info] Input file: {input_path}")
    print(f"[Info] Output file: {output_path}")
    print(f"[Response Model]: {args.chat_model}")

    run_eval(
        questions_file=input_path,
        output_file=output_path,
        version_dir=version_dir,
        max_workers=args.workers,
        top_k=args.top_k,
    )
