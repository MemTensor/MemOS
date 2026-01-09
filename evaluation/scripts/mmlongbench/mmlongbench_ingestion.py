#!/usr/bin/env python3

import argparse
import json
import threading
import time

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from langchain_text_splitters import Language, RecursiveCharacterTextSplitter

from evaluation.scripts.utils.metrics import Metrics


def read_filenames(filepath: str) -> list[str]:
    """
    Read filename list from file
    Supports one filename per line, automatically removes empty lines and whitespace
    """
    filenames = []
    with open(filepath, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:  # Skip empty lines
                filenames.append(line)
    return filenames


def run_concurrent_add(
    lib: str,
    filenames: list[str],
    url_prefix: str,
    user_prefix: str,
    workers: int,
    source_type: str = "extreme_multimodal",
    mode: str = "fine",
    async_mode: str = "sync",
) -> dict:
    """
    Execute concurrent add operations

    Args:
        lib: Client name
        filenames: List of filenames
        url_prefix: URL prefix
        user_prefix: User ID prefix
        workers: Concurrency
        source_type: Source type
        mode: Mode
        async_mode: Async mode

    Returns:
        Statistics result
    """

    client = _get_lib_client(lib)
    metrics = Metrics()
    total_files = len(filenames)
    completed = 0
    completed_lock = threading.Lock()
    user_id = user_prefix

    def add_single_file(filename: str, doc_id: str = ""):
        nonlocal completed

        file_id = filename  # 文件名作为file_id
        file_data = f"{url_prefix.rstrip('/')}/{filename}"  # URL前缀 + 文件名

        base_dir = Path("ppt_test_result")
        all_md_files = list(base_dir.rglob("*.md"))
        stem = Path(file_id).stem.lower()
        name = file_id.lower()
        md_path = ""
        for md in all_md_files:
            pstr = str(md).lower()
            if (stem and stem in pstr) or (name and name in pstr):
                md_path = md
        text = md_path.read_text(encoding="utf-8", errors="ignore")

        start_time = time.perf_counter()
        user_id = user_prefix + "_" + doc_id
        writable_cube_ids = [user_id]
        chat_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        result = None
        try:
            if lib == "memos":
                messages = [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "file",
                                "file": {
                                    "file_id": file_id,
                                    "filename": file_data,
                                    "file_data": file_data,
                                },
                            }
                        ],
                        "chat_time": chat_time,
                    }
                ]
                result = client.add(
                    messages=messages,
                    user_id=user_id,
                    writable_cube_ids=writable_cube_ids,
                    source_type=source_type,
                    mode=mode,
                    async_mode=async_mode,
                )
            elif lib == "supermemory":
                result = client.add(content=text, user_id=user_id)
            elif lib == "mem0":
                chunker = RecursiveCharacterTextSplitter.from_language(
                    language=Language.PYTHON, chunk_size=5120, chunk_overlap=128
                )
                paragraphs = [p for p in chunker.split_text(text) if p.strip()]
                messages = [{"role": "user", "content": p} for p in paragraphs]
                ts = int(time.time())

                result = client.add(messages=messages, user_id=doc_id, timestamp=ts, batch_size=10)

            duration = time.perf_counter() - start_time
            metrics.record(duration, True)

            with completed_lock:
                completed += 1
                print(
                    f"[{completed}/{total_files}] ✓ Success: {filename} ({duration * 1000:.0f}ms)"
                )

            return True, result

        except Exception as e:
            duration = time.perf_counter() - start_time
            error_msg = str(e)
            metrics.record(duration, False, error_msg)

            with completed_lock:
                completed += 1
                print(f"[{completed}/{total_files}] ✗ Failed: {filename} - {error_msg[:100]}")

            return False, error_msg

    print(f"\nStarting concurrent add for {total_files} files...")
    print(f"Concurrency: {workers}")
    print(f"User ID: {user_id}")
    print(f"URL prefix: {url_prefix}")
    print("-" * 60)

    start_time = time.time()

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = []
        for _, filename in enumerate(filenames):
            doc_id = filename[:-3] + ".pdf"
            future = executor.submit(add_single_file, filename, doc_id)
            futures.append((filename, future))

        # Wait for all tasks to complete
        results = []
        for filename, future in futures:
            try:
                success, result = future.result()
                results.append({"filename": filename, "success": success, "result": result})
            except Exception as e:
                results.append({"filename": filename, "success": False, "result": str(e)})

    end_time = time.time()
    total_duration = end_time - start_time

    # Print statistics
    summary = metrics.summary()

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

    if summary["errors"]:
        print("\nError statistics:")
        for error, count in sorted(summary["errors"].items(), key=lambda x: x[1], reverse=True)[:5]:
            print(f"  [{count} times] {error[:100]}...")

    return {"summary": summary, "total_duration": total_duration, "results": results}


def parse_args():
    parser = argparse.ArgumentParser(
        description="MMLongbench-doc Product Add Concurrent Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--lib", "-b", required=True, help="Product name to evaluate")
    parser.add_argument(
        "--filenames-file",
        "-f",
        default="evaluation/data/mmlongbench/md_file_list.txt",
        help="Path to text file containing list of filenames (one per line)",
    )

    parser.add_argument(
        "--url-prefix",
        "-u",
        default="https://memos-knowledge-base-file-pre.oss-cn-shanghai.aliyuncs.com/ppt_md_files/",
        help="URL prefix to be prepended to filenames",
    )

    parser.add_argument(
        "--api-url",
        default="http://127.0.0.1:8001",
        help="MemOS API address (default: http://127.0.0.1:8001)",
    )

    parser.add_argument("--workers", "-w", type=int, default=5, help="Concurrency (default: 5)")

    parser.add_argument(
        "--timeout", type=float, default=1200, help="Request timeout in seconds (default: 120)"
    )

    parser.add_argument(
        "--source-type",
        default="extreme_multimodal",
        help="Source type (default: extreme_multimodal)",
    )

    parser.add_argument(
        "--mode", default="fine", choices=["fine", "fast"], help="Processing mode (default: fine)"
    )

    parser.add_argument(
        "--async-mode", default="sync", choices=["sync", "async"], help="Async mode (default: sync)"
    )

    parser.add_argument("--version-dir", "-v", default=None, help="Version directory name")

    return parser.parse_args()


def _get_lib_client(lib: str):
    if lib == "memos":
        from evaluation.scripts.utils.client import MemosApiClient

        return MemosApiClient()
    if lib == "mem0":
        from evaluation.scripts.utils.client import Mem0Client

        return Mem0Client(enable_graph=False)
    if lib == "supermemory":
        from evaluation.scripts.utils.client import SupermemoryClient

        return SupermemoryClient()


def main():
    args = parse_args()

    print("=" * 60)
    print("MMLongbench-doc Product Add Concurrent Tool")
    print("=" * 60)

    # Read filename list
    print(f"\nReading filename list: {args.filenames_file}")
    try:
        filenames = read_filenames(args.filenames_file)
        print(f"Read {len(filenames)} filenames")
        if len(filenames) == 0:
            print("Error: Filename list is empty!")
            return

        # Show first few filenames
        print("First 5 filenames:")
        for fn in filenames[:5]:
            print(f"  - {fn}")
        if len(filenames) > 5:
            print(f"  ... and {len(filenames) - 5} more files")

    except FileNotFoundError:
        print(f"Error: File not found {args.filenames_file}")
        return
    except Exception as e:
        print(f"Error: Failed to read file - {e}")
        return

    # Execute concurrent add
    result = run_concurrent_add(
        lib=args.lib,
        filenames=filenames,
        url_prefix=args.url_prefix,
        user_prefix=args.version_dir,
        workers=args.workers,
        source_type=args.source_type,
        mode=args.mode,
        async_mode=args.async_mode,
    )

    # Determine output file path
    import os

    version_output_dir = os.path.join("evaluation/data/mmlongbench", args.version_dir)
    os.makedirs(version_output_dir, exist_ok=True)
    output_path = os.path.join(version_output_dir, f"{args.lib}_add_results.json")

    # Save results to file
    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            # Remove non-serializable content
            output_data = {
                "summary": result["summary"],
                "total_duration": result["total_duration"],
                "config": {
                    "filenames_file": args.filenames_file,
                    "url_prefix": args.url_prefix,
                    "api_url": args.api_url,
                    "concurrency": args.workers,
                    "source_type": args.source_type,
                    "mode": args.mode,
                    "async_mode": args.async_mode,
                    "version_dir": args.version_dir,
                },
            }
            json.dump(output_data, f, ensure_ascii=False, indent=2)
        print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
