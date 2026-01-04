import argparse
import json
import os
import time

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from tqdm import tqdm

from evaluation.scripts.hotpot.data_loader import load_hotpot_data
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


def _load_added_ids(records_path: Path) -> set[str]:
    if not records_path.exists():
        return set()
    try:
        obj = json.loads(records_path.read_text(encoding="utf-8"))
        ids = obj.get("added_ids") if isinstance(obj, dict) else None
        if isinstance(ids, list):
            return {str(x) for x in ids if x}
    except Exception:
        return set()
    return set()


def _save_added_ids(records_path: Path, added_ids: set[str], perf: dict | None = None) -> None:
    records_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = records_path.with_suffix(records_path.suffix + ".tmp")
    obj = {"added_ids": sorted(added_ids)}
    if perf is not None:
        obj["perf"] = perf
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, records_path)


def _build_memory_texts(ctx: dict | list | None) -> list[str]:
    tasks: list[str] = []
    for item in ctx:
        if not isinstance(item, list | tuple) or len(item) != 2:
            continue
        title, sentences = item
        if not isinstance(sentences, list):
            continue
        for idx, sentence in enumerate(sentences):
            tasks.append(
                json.dumps({"idx": idx, "title": title, "sentence": sentence}, ensure_ascii=False)
            )
    return tasks


def add_context_memories(
    client,
    lib: str,
    user_id: str,
    ctx: dict | list | None,
    mode: str = "fine",
    async_mode: str = "sync",
) -> None:
    tasks = _build_memory_texts(ctx)
    if not tasks:
        return

    if lib == "memos":
        messages = [{"type": "text", "text": content} for content in tasks]
        writable_cube_ids = [user_id]
        retry_operation(
            client.add,
            messages=messages,
            user_id=user_id,
            writable_cube_ids=writable_cube_ids,
            source_type="batch_import",
            mode=mode,
            async_mode=async_mode,
        )
        return

    if lib == "mem0":
        ts = int(time.time())
        messages = [{"role": "user", "content": content} for content in tasks]
        retry_operation(client.add, messages=messages, user_id=user_id, timestamp=ts, batch_size=10)
        return

    if lib == "supermemory":
        for content in tasks:
            retry_operation(client.add, content=content, user_id=user_id)


def ingest_one(client, lib: str, item: dict, version_dir: str) -> str:
    qid = item.get("_id") or item.get("id")
    ctx = item.get("context")

    user_id = version_dir + "_" + str(qid)
    add_context_memories(client, lib, user_id, ctx)
    return str(qid)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="HotpotQA ingestion (add only).")
    parser.add_argument(
        "--lib",
        type=str,
        default="memos",
        choices=["memos", "mem0", "supermemory"],
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--version-dir", "-v", default=None, help="Version directory name")
    parser.add_argument(
        "--mode", default="fine", choices=["fine", "fast"], help="Processing mode (default: fine)"
    )
    parser.add_argument(
        "--async-mode", default="sync", choices=["sync", "async"], help="Async mode (default: sync)"
    )

    args = parser.parse_args(argv)

    print("=" * 60)
    print("hotpotQA Product Add Concurrent Tool")
    print("=" * 60)

    output_dir = Path("evaluation/data/hotpot")
    if args.version_dir:
        output_dir = output_dir / args.version_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    items_list = load_hotpot_data("evaluation/data/hotpot")
    if args.limit is not None:
        items_list = items_list[: args.limit]

    records_path = output_dir / f"{args.lib}_added_records.json"
    added_ids = _load_added_ids(records_path)
    pending_items = []
    for it in items_list:
        qid = it.get("_id") or it.get("id")
        if str(qid) not in added_ids:
            pending_items.append(it)

    print(f"[Add] lib={args.lib} total={len(items_list)} pending={len(pending_items)}")
    if not pending_items:
        return

    client = _get_lib_client(args.lib)
    metrics = Metrics()

    def do_ingest(item):
        start_time = time.perf_counter()
        try:
            sid = ingest_one(client, args.lib, item, args.version_dir)
            duration = time.perf_counter() - start_time
            metrics.record(duration, True)
            return sid
        except Exception as e:
            duration = time.perf_counter() - start_time
            metrics.record(duration, False, str(e))
            raise e

    start_time = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(do_ingest, it) for it in pending_items]
        for idx, f in enumerate(tqdm(as_completed(futures), total=len(futures), desc="Adding"), 1):
            try:
                sid = f.result()
                if sid:
                    added_ids.add(str(sid))
                    if idx % 20 == 0:
                        _save_added_ids(records_path, added_ids)
            except Exception as e:
                print(f"[Add] Error: {e}")

    _save_added_ids(records_path, added_ids)
    print(f"[Add] saved records to {records_path}")

    total_duration = time.time() - start_time
    summary = metrics.summary()
    perf_obj = {
        "summary": summary,
        "total_duration": total_duration,
        "config": {
            "workers": args.workers,
            "mode": args.mode,
            "async_mode": args.async_mode,
            "lib": args.lib,
        },
    }
    _save_added_ids(records_path, added_ids, perf=perf_obj)

    print("\n" + "=" * 60)
    print("Ingestion finished! Statistics:")
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


if __name__ == "__main__":
    main()
