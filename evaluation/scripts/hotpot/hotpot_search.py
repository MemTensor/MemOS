import argparse
import json
import os
import time
import traceback

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from tqdm import tqdm

from evaluation.scripts.hotpot.data_loader import load_hotpot_data
from evaluation.scripts.utils.metrics import Metrics


def retry_operation(func, *args, retries=5, delay=2, **kwargs):
    for attempt in range(retries):
        try:
            result = func(*args, **kwargs)
            if isinstance(result, dict) and "data" in result:
                return result["data"]
            return result
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


def get_sources_info(sources):
    seen = set()
    dedup_sp = []
    mem_texts = []

    for source in sources:
        if isinstance(source, str):
            try:
                obj = json.loads(source)
            except json.JSONDecodeError:
                continue

        title = obj.get("title")
        idx = obj.get("idx")
        sentence = obj.get("sentence")

        if title is None or idx is None:
            continue

        key = (title, idx)
        if key not in seen:
            seen.add(key)
            dedup_sp.append([title, idx])
            mem_texts.append(sentence)

    return mem_texts, dedup_sp


def memos_search(
    client, user_id: str, query: str, top_k: int, search_mode: str
) -> tuple[str, list[list[str | int]]]:
    readable_cube_ids = [user_id]
    results = retry_operation(
        client.search,
        query=query,
        user_id=user_id,
        readable_cube_ids=readable_cube_ids,
        top_k=top_k,
        mode=search_mode,
    )
    memories = results["text_mem"][0]["memories"]
    mem_texts = [i["memory"] for i in memories]

    sources = []
    for m in memories:
        source = (m.get("metadata", {}) or {}).get("sources") or []
        for s in source:
            source_txt = json.loads(s["content"])
            sources.append(json.loads(source_txt)["content"])
        sources.extend(source)

    _, dedup_sp = get_sources_info(sources)
    return mem_texts, dedup_sp


def mem0_search(client, user_id: str, query: str, top_k: int) -> tuple[str, list[list[str | int]]]:
    res = retry_operation(client.search, query, user_id, top_k)
    sources = [m.get("memory", "") for m in res.get("results", []) if m.get("memory")]
    mem_texts, dedup_sp = get_sources_info(sources)
    return mem_texts, dedup_sp


def supermemory_search(
    client, user_id: str, query: str, top_k: int
) -> tuple[str, list[list[str | int]]]:
    sources = retry_operation(client.search, query, user_id, top_k)
    mem_texts, dedup_sp = get_sources_info(sources)
    return mem_texts, dedup_sp


def search_one(
    client, lib: str, item: dict, top_k: int, version_dir: str, search_mode: str
) -> dict:
    qid = item.get("_id") or item.get("id")
    question = item.get("question") or ""
    user_id = version_dir + "_" + str(qid)

    if lib == "memos":
        memories, sp_list = memos_search(client, user_id, str(question), top_k, search_mode)
    elif lib == "mem0":
        memories, sp_list = mem0_search(client, user_id, str(question), top_k)
    elif lib == "supermemory":
        memories, sp_list = supermemory_search(client, user_id, str(question), top_k)
    else:
        memories, sp_list = [], []

    return {
        "_id": str(qid),
        "question": question,
        "answer": item.get("answer"),
        "memories": memories,
        "sp": sp_list,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="HotpotQA search (search only).")
    parser.add_argument(
        "--lib",
        type=str,
        default="memos",
        choices=["memos", "mem0", "supermemory"],
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--top-k", type=int, default=7)
    parser.add_argument(
        "--limit", type=int, default=None, help="Limit number of samples (was max_samples)"
    )
    parser.add_argument("--version-dir", "-v", default=None, help="Version directory name")
    parser.add_argument("--search-mode", default="fine", help="Search mode")

    args = parser.parse_args(argv)

    # Handle limit/max_samples compatibility
    limit = args.limit if args.limit is not None else args.max_samples

    items_list = load_hotpot_data("evaluation/data/hotpot")
    if limit is not None:
        items_list = items_list[:limit]

    output_dir = Path(f"evaluation/data/hotpot/{args.version_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.lib == "memos":
        output_path = output_dir / f"{args.lib}_{args.search_mode}_search_results.json"
    else:
        output_path = output_dir / f"{args.lib}_search_results.json"

    output_path.parent.mkdir(parents=True, exist_ok=True)

    results, processed_ids = _load_existing_results(output_path)
    pending_items = []
    for it in items_list:
        qid = it.get("_id") or it.get("id")
        if str(qid) not in processed_ids:
            pending_items.append(it)

    print(
        f"[Search] lib={args.lib} total={len(items_list)} pending={len(pending_items)} top_k={args.top_k}"
    )
    if not pending_items:
        return

    client = _get_lib_client(args.lib)
    metrics = Metrics()
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as executor:

        def do_search(item):
            st = time.perf_counter()
            try:
                r = search_one(
                    client, args.lib, item, args.top_k, args.version_dir, args.search_mode
                )
                dur = time.perf_counter() - st
                metrics.record(dur, True)
                return r
            except Exception as e:
                dur = time.perf_counter() - st
                metrics.record(dur, False, str(e))
                raise e

        futures = [executor.submit(do_search, it) for it in pending_items]
        for idx, f in enumerate(
            tqdm(as_completed(futures), total=len(futures), desc="Searching"), 1
        ):
            try:
                r = f.result()
                results.append(r)
                if idx % 20 == 0:
                    _save_json_list(output_path, results)
            except Exception as e:
                print(f"[Search] Error: {e}")
                traceback.print_exc()

    _save_json_list(output_path, results)
    print(f"[Search] saved {len(results)} rows to {output_path}")

    # Save performance metrics
    total_duration = time.time() - start_time
    summary = metrics.summary()
    # Merge perf into results json file
    combined_obj = {
        "results": results,
        "perf": {
            "summary": summary,
            "total_duration": total_duration,
            "config": {
                "workers": args.workers,
                "top_k": args.top_k,
                "limit": limit,
                "search_mode": args.search_mode,
                "lib": args.lib,
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
