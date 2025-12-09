import json
import os
import sys
import time

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from eval.eval_score import eval_acc_and_f1, eval_score, show_results  # type: ignore
from eval.extract_answer import extract_answer  # type: ignore
from langchain_text_splitters import Language, RecursiveCharacterTextSplitter
from openai import OpenAI


# Ensure project paths for imports
PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
sys.path.append(str(SCRIPTS_ROOT))
sys.path.append(str(SRC_ROOT))
load_dotenv()
max_retries = 5
RESULTS_PATH = "evaluation/data/mmlongbench/test_results.json"


def iter_markdown_files(base_dir: str | Path) -> Iterator[Path]:
    base = Path(base_dir)
    if not base.exists():
        return
    # glob all 'auto/*.md'
    for md in base.rglob("auto/*.md"):
        if md.is_file():
            yield md


def _get_clients():
    from utils.client import MemosApiClient  # type: ignore
    from utils.prompts import MEMOS_CONTEXT_TEMPLATE  # type: ignore

    from memos.mem_os.core import add_images_context, get_images  # type: ignore

    memos_client = MemosApiClient()
    openai_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )
    return memos_client, openai_client, MEMOS_CONTEXT_TEMPLATE, add_images_context, get_images


def _get_lib_client(lib: str):
    if lib == "mem0":
        from utils.client import Mem0Client  # type: ignore

        return Mem0Client(enable_graph=False)
    if lib == "supermemory":
        from utils.client import SupermemoryClient  # type: ignore

        return SupermemoryClient()
    from utils.client import MemosApiClient  # type: ignore

    return MemosApiClient()


def _load_existing_results():
    completed_pairs: set[tuple[str, str]] = set()
    completed_docs: set[str] = set()
    existing: list[dict] = []
    p = Path(RESULTS_PATH)
    if p.exists():
        try:
            existing = json.loads(p.read_text(encoding="utf-8"))
            for r in existing:
                did = str(r.get("doc_id") or "").strip()
                q = str(r.get("question") or "").strip()
                # normalize whitespace for robust resume
                did_norm = did
                q_norm = " ".join(q.split())
                if did:
                    completed_docs.add(did)
                if did_norm and q_norm:
                    completed_pairs.add((did_norm, q_norm))
        except Exception:
            existing = []
    return existing, completed_pairs, completed_docs


def add_context(client, user_id: str, md_path: Path, lib) -> None:
    # Read markdown and add per paragraph
    text = md_path.read_text(encoding="utf-8", errors="ignore")
    # Chunk by langchain text splitters (align with sentence_chunker style)
    chunker = RecursiveCharacterTextSplitter.from_language(
        language=Language.PYTHON, chunk_size=512, chunk_overlap=128
    )
    paragraphs = [p for p in chunker.split_text(text) if p.strip()]
    print(f"[Ingest] doc_id={user_id} paragraphs={len(paragraphs)} path={md_path}")

    if lib == "memos":
        messages = [{"role": "user", "content": p} for p in paragraphs]
        ts = int(time.time())
        try:
            client.add(messages=messages, user_id=user_id, conv_id=user_id)
            print(f"[Add-memos] user={user_id} total={len(messages)}")
        except Exception as e:
            print(f"[Add-memos] failed: {e}")

    elif lib == "mem0":
        messages = [{"role": "user", "content": p} for p in paragraphs]
        ts = int(time.time())
        try:
            client.add(messages=messages, user_id=user_id, timestamp=ts, batch_size=10)
            print(f"[Add-mem0] user={user_id} total={len(messages)}")
        except Exception as e:
            print(f"[Add-mem0] failed: {e}")
    elif lib == "supermemory":
        iso = datetime.utcnow().isoformat() + "Z"
        messages = [{"role": "user", "content": p, "chat_time": iso} for p in paragraphs]
        try:
            client.add(messages=messages, user_id=user_id)
            print(f"[Add-supermemory] user={user_id} total={len(messages)}")
        except Exception as e:
            print(f"[Add-supermemory] failed: {e}")


def memos_search(
    client, get_images, user_id: str, query: str, top_k: int = 15
) -> tuple[list[str], list[str]]:
    results = client.search(query=query, user_id=user_id, top_k=top_k)
    memories = results["text_mem"][0]["memories"]
    mem_texts = [m["memory"] for m in memories]

    # Collect possible image paths from memory texts (and any source content if present)
    sources_texts: list[str] = []
    for m in memories:
        srcs = (m.get("metadata", {}) or {}).get("sources") or []
        for s in srcs:
            content = s.get("content") if isinstance(s, dict) else str(s)
            if content:
                sources_texts.append(content)
    candidates = mem_texts + sources_texts
    image_paths = get_images(candidates)
    print(
        f"[Search] user={user_id} top_k={top_k} memories={len(memories)} images={len(image_paths)}"
    )
    return mem_texts, image_paths


def mem0_search(
    client, get_images, user_id: str, query: str, top_k: int = 15
) -> tuple[list[str], list[str]]:
    res = client.search(query, user_id, top_k)
    results = res.get("results", [])
    mem_texts = [m.get("memory", "") for m in results if m.get("memory")]
    image_paths = get_images(mem_texts)
    print(
        f"[Search] user={user_id} top_k={top_k} memories={len(results)} images={len(image_paths)}"
    )
    return mem_texts, image_paths


def supermemory_search(
    client, get_images, user_id: str, query: str, top_k: int = 15
) -> tuple[list[str], list[str]]:
    chunk_list = client.search(query, user_id, top_k)
    image_paths = get_images(chunk_list)
    print(
        f"[Search] user={user_id} top_k={top_k} memories={len(chunk_list)} images={len(image_paths)}"
    )
    return chunk_list, image_paths


def multimodal_answer(
    add_images_context, oai_client, memories: list[str], question: str, image_paths: list[str]
) -> str:
    from memos.mem_os.core import MOSCore  # type: ignore

    system_prompt = MOSCore._build_system_prompt(MOSCore.__new__(MOSCore), memories)

    messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": question}]
    add_images_context(messages, image_paths)
    resp = oai_client.chat.completions.create(
        model=os.getenv("CHAT_MODEL"), messages=messages, temperature=0
    )
    return resp.choices[0].message.content or ""


def run_ingest_and_eval(
    ppt_root: str | Path = "ppt_test_result",
    questions_file: str | Path | None = None,
    top_k: int = 15,
    lib: str = "memos",
    workers: int = 2,
) -> None:
    client, oai_client, memos_context_template, add_images_context, get_images = _get_clients()
    if questions_file and Path(questions_file).exists():
        data = json.loads(Path(questions_file).read_text(encoding="utf-8"))
        print(f"[Load] samples={len(data)} file={questions_file}")

        # Build allowed doc list from documents directory (align with eval_docs grouping by doc_id)
        docs_dir = Path("evaluation/data/mmlongbench/documents")
        allowed_docs: set[str] = set()
        if docs_dir.exists():
            for f in docs_dir.iterdir():
                if f.is_file():
                    allowed_docs.add(f.name)
        if allowed_docs:
            print(f"[Filter] allowed_docs={len(allowed_docs)} from {docs_dir}")

        # Determine doc_ids present in samples and apply allowed filter
        doc_ids_in_samples = {str(s.get("doc_id") or "").strip() for s in data if s.get("doc_id")}
        doc_list = [d for d in doc_ids_in_samples if (not allowed_docs or d in allowed_docs)]
        doc_list.sort()

        # Resume state
        existing, completed_pairs, completed_docs = _load_existing_results()
        print(f"[Resume] loaded_results={len(existing)} completed_docs={len(completed_docs)}")
        results: list[dict] = list(existing)
        ingested_doc_ids: set[str] = set(completed_docs)

        base_dir = Path(ppt_root)
        all_md_files: list[Path] = []
        if base_dir.exists():
            all_md_files = list(base_dir.rglob("*.md"))

        def _find_md_for_doc(doc_id_val: str) -> Path | None:
            stem = Path(doc_id_val).stem.lower()
            name = doc_id_val.lower()
            for md in all_md_files:
                pstr = str(md).lower()
                if (stem and stem in pstr) or (name and name in pstr):
                    return md
            return None

        to_ingest: list[tuple[str, Path]] = []
        for did in doc_list:
            if did and did not in ingested_doc_ids:
                mdp = _find_md_for_doc(did)
                if mdp is not None:
                    to_ingest.append((did, mdp))
                else:
                    print(f"[Skip] markdown not found for doc_id={did}")

        if to_ingest:
            print(f"[Ingest-Concurrent] tasks={len(to_ingest)} from {ppt_root}")

            def _ingest_one(doc_id_local: str, md_path_local: Path, lib_local: str = lib) -> str:
                user_id_local = doc_id_local
                c_local = client if lib_local == "memos" else _get_lib_client(lib_local)
                add_context(c_local, user_id_local, md_path_local, lib=lib_local)
                return doc_id_local

            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = [executor.submit(_ingest_one, did, mdp) for did, mdp in to_ingest]
                for f in as_completed(futures):
                    try:
                        done_id = f.result()
                        ingested_doc_ids.add(done_id)
                    except Exception as e:
                        print(f"[Add-Error] {e}")

        for doc_id in doc_list:
            if not doc_id:
                continue
            print(f"\n===== [Doc] {doc_id} =====")
            user_id = doc_id

            doc_samples = [s for s in data if str(s.get("doc_id") or "").strip() == doc_id]

            def _process_item(
                item: dict,
                doc_id_local: str = doc_id,
                user_id_local: str = user_id,
                lib_local: str = lib,
            ) -> dict:
                q = item["question"]
                q_norm_local = " ".join(str(q).split())
                if (doc_id_local, q_norm_local) in completed_pairs:
                    return {"skip": True}
                if lib_local == "memos":
                    memories, images = memos_search(
                        client, get_images, user_id_local, q, top_k=top_k
                    )
                elif lib_local == "mem0":
                    c_local = _get_lib_client(lib_local)
                    memories, images = mem0_search(
                        c_local, get_images, user_id_local, q, top_k=top_k
                    )
                elif lib_local == "supermemory":
                    c_local = _get_lib_client(lib_local)
                    memories, images = supermemory_search(
                        c_local, get_images, user_id_local, q, top_k=top_k
                    )
                else:
                    memories, images = [], []
                resp = multimodal_answer(add_images_context, oai_client, memories, q, images)
                with open(
                    Path("evaluation/scripts/mmlongbench/eval/prompt_for_answer_extraction.md"),
                    encoding="utf-8",
                ) as f:
                    prompt_local = f.read()
                extracted_res_local = extract_answer(q, resp, prompt_local)
                try:
                    pred_ans_local = (
                        extracted_res_local.split("Answer format:")[0]
                        .split("Extracted answer:")[1]
                        .strip()
                    )
                except Exception:
                    pred_ans_local = resp.strip()
                score_local = eval_score(
                    item.get("answer"), pred_ans_local, item.get("answer_format", "Str")
                )
                sr = dict(item)
                sr["response"] = resp
                sr["extracted_res"] = extracted_res_local
                sr["pred"] = pred_ans_local
                sr["score"] = score_local
                sr["q_norm"] = q_norm_local
                sr["images"] = images
                return sr

            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = [executor.submit(_process_item, it) for it in doc_samples]
                for f in as_completed(futures):
                    try:
                        res = f.result()
                        if res.get("skip"):
                            continue
                        print("[images used]:", res.get("images") or [])
                        print(
                            f"[QA] doc_id={doc_id} images={len(res.get('images') or [])} score={res.get('score')}"
                        )
                        results.append(
                            {k: v for k, v in res.items() if k not in ("q_norm", "images")}
                        )
                        completed_pairs.add((doc_id, res.get("q_norm") or ""))

                        print("[Question]:", res.get("question"))
                        print("[Answer]:", res.get("pred"))
                        print("[Ground truth]:", res.get("answer"))
                        print("[Score]:", res.get("score"))
                        out_json = Path("evaluation/data/mmlongbench/test_results.json")
                        out_json.parent.mkdir(parents=True, exist_ok=True)
                        out_json.write_text(
                            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
                        )
                        acc, f1 = eval_acc_and_f1(results)
                        total_target = sum(
                            1 for s in data if str(s.get("doc_id") or "") in doc_list
                        )
                        print(f"[Metric] acc={acc} f1={f1} processed={len(results)}/{total_target}")
                    except Exception as e:
                        print(f"[Error] processing item: {e}")

        report_path = Path("evaluation/data/mmlongbench/test_results_report.txt")
        show_results(results, show_path=str(report_path))
        print(f"[Report] saved to {report_path}")


if __name__ == "__main__":
    run_ingest_and_eval(questions_file=Path("evaluation/data/mmlongbench/samples.json"))
