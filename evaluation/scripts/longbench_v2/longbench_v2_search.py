import argparse
import json
import os
import time
import traceback

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from tqdm import tqdm

from evaluation.scripts.utils.metrics import Metrics


load_dotenv()


def retry_operation(func, *args, retries=5, delay=2, **kwargs):
    for attempt in range(retries):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            if attempt < retries - 1:
                func_name = getattr(func, "__name__", "Operation")
                print(f"[Retry] {func_name} failed: {e}. Retrying in {delay}s...")
                time.sleep(delay)
                delay *= 2
            else:
                raise e


def _get_lib_client(lib: str):
    if lib == "mem0":
        from evaluation.scripts.utils.client import Mem0Client

        return Mem0Client(enable_graph=False)
    if lib == "supermemory":
        from evaluation.scripts.utils.client import SupermemoryClient

        return SupermemoryClient()
    from evaluation.scripts.utils.client import MemosApiClient

    return MemosApiClient()


def _load_dataset_jsonl(dataset_path: Path) -> list[dict]:
    samples: list[dict] = []
    with open(dataset_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            samples.append(json.loads(line))
    return samples


def memos_search(client, user_id: str, query: str, top_k: int = 30) -> list[str]:
    results = retry_operation(client.search, query=query, user_id=user_id, top_k=top_k)
    memories = results["text_mem"][0]["memories"]
    return [m["memory"] for m in memories]


def mem0_search(client, user_id: str, query: str, top_k: int = 30) -> list[str]:
    res = retry_operation(client.search, query, user_id, top_k)
    results = res.get("results", [])
    return [m.get("memory", "") for m in results if m.get("memory")]


def supermemory_search(client, user_id: str, query: str, top_k: int = 30) -> list[str]:
    return retry_operation(client.search, query, user_id, top_k)


def _load_existing_results(output_path: Path) -> tuple[list[dict], set[str]]:
    if not output_path.exists():
        return [], set()
    try:
        data = json.loads(output_path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            ids = {str(r.get("_id")) for r in data if r.get("_id")}
            return data, ids
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            rows = data.get("results") or []
            ids = {str(r.get("_id")) for r in rows if r.get("_id")}
            return rows, ids
    except Exception:
        return [], set()
    return [], set()


def _save_json_list(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps({"results": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def search_one(client, sample: dict, lib: str, top_k: int) -> dict:
    sample_id = str(sample.get("_id"))
    user_id = sample_id
    question = sample.get("question") or ""
    choices = {
        "A": sample.get("choice_A") or "",
        "B": sample.get("choice_B") or "",
        "C": sample.get("choice_C") or "",
        "D": sample.get("choice_D") or "",
    }

    if lib == "memos":
        memories = memos_search(client, user_id, str(question), top_k=top_k)
    elif lib == "mem0":
        memories = mem0_search(client, user_id, str(question), top_k=top_k)
    elif lib == "supermemory":
        memories = supermemory_search(client, user_id, str(question), top_k=top_k)
    else:
        memories = []
    print(f"[{lib} Search] sample_id: {sample_id} search memories: {len(memories)}")

    return {
        "_id": sample_id,
        "domain": sample.get("domain"),
        "sub_domain": sample.get("sub_domain"),
        "difficulty": sample.get("difficulty"),
        "length": sample.get("length"),
        "question": question,
        "choices": choices,
        "answer": sample.get("answer"),
        "memories_used": memories,
    }


def parse_args():
    parser = argparse.ArgumentParser(
        description="Longbench-v2 Product Search Concurrent Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument("--lib", "-b", required=True, help="Product name to evaluate")

    parser.add_argument(
        "--dataset-path",
        "-s",
        default="evaluation/data/longbench_v2/longbenchv2_train.json",
        help="Path to JSON file containing samples",
    )

    parser.add_argument(
        "--api-url",
        default="http://127.0.0.1:8001",
        help="API service address (default: http://127.0.0.1:8001)",
    )

    parser.add_argument("--workers", "-c", type=int, default=5, help="Concurrency (default: 5)")

    parser.add_argument(
        "--timeout", type=float, default=120.0, help="Request timeout in seconds (default: 120)"
    )

    parser.add_argument(
        "--top-k",
        "-k",
        type=int,
        default=20,
        help="Number of results to return per search (default: 20)",
    )

    parser.add_argument("--version-dir", "-v", default=None, help="Version directory name")

    parser.add_argument(
        "--limit",
        "-l",
        type=int,
        default=None,
        help="Limit number of samples to process (for testing, default all)",
    )

    parser.add_argument(
        "--mode", "-m", type=str, default="fast", help="Search mode (default: fast)"
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    print("=" * 60)
    print("Longbench-v2 Product Search Concurrent Tool")
    print("=" * 60)

    dataset_path = Path(args.dataset_path)
    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset file not found: {dataset_path}")
    dataset = _load_dataset_jsonl(dataset_path)
    if args.limit is not None:
        dataset = dataset[: args.limit]

    output_dir = os.path.join("evaluation/data/longbench_v2", args.version_dir)
    os.makedirs(output_dir, exist_ok=True)
    output_filename = f"{args.lib}_search_results.json"
    output_path = Path(os.path.join(output_dir, output_filename))

    results, processed_ids = _load_existing_results(output_path)
    pending = [s for s in dataset if str(s.get("_id")) not in processed_ids]
    if not pending:
        return

    client = _get_lib_client(args.lib)
    metrics = Metrics()
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as executor:

        def do_search(sample: dict) -> dict:
            st = time.perf_counter()
            r = search_one(client, sample, args.lib, args.top_k)
            dur = time.perf_counter() - st
            r["duration_ms"] = dur * 1000
            metrics.record(dur, True)
            return r

        futures = [executor.submit(do_search, sample) for sample in pending]
        for idx, f in enumerate(
            tqdm(as_completed(futures), total=len(futures), desc="Searching"), start=1
        ):
            try:
                r = f.result()
                results.append(r)
                if idx % 10 == 0:
                    _save_json_list(output_path, results)
            except Exception as e:
                metrics.record(0.0, False, str(e))
                print(f"[Search] Error: {e}")
                traceback.print_exc()

    _save_json_list(output_path, results)
    print(f"[Search] saved {len(results)} rows to {output_path}")

    total_duration = time.time() - start_time
    summary = metrics.summary()
    combined_obj = {
        "results": results,
        "perf": {
            "summary": summary,
            "total_duration": total_duration,
            "config": {
                "workers": args.workers,
                "top_k": args.top_k,
                "dataset_path": str(dataset_path),
                "limit": args.limit,
                "mode": args.mode,
            },
        },
    }
    tmp = output_path.with_suffix(output_path.suffix + ".tmp")
    tmp.write_text(json.dumps(combined_obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, output_path)

    print("\n" + "=" * 60)
    print("Search finished! Statistics:")
    print("=" * 60)
    print(f"Total duration: {total_duration:.2f}s")
    print(f"Success: {summary['counts']['success']} / Failed: {summary['counts']['failed']}")

    if summary["stats"]:
        stats = summary["stats"]
        qps = stats["count"] / total_duration if total_duration > 0 else 0
        print(f"QPS: {qps:.2f}")
        print("Latency stats (ms):")
        print(f"  Mean: {stats['mean']:.2f}")
        print(f"  Median: {stats['median']:.2f}")
        print(f"  Min: {stats['min']:.2f}")
        print(f"  Max: {stats['max']:.2f}")
        print(f"  P95: {stats['p95']:.2f}")
        print(f"  P99: {stats['p99']:.2f}")

    if summary["errors"]:
        print("\nError stats:")
        for error, count in sorted(summary["errors"].items(), key=lambda x: x[1], reverse=True)[:5]:
            print(f"  [{count} times] {error[:100]}...")


if __name__ == "__main__":
    main()
