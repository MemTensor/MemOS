import argparse
import importlib.util
import json
import os
import time

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

from evaluation.scripts.hotpot.data_loader import load_hotpot_data
from evaluation.scripts.utils.extract_answer import extract_answer, parse_extracted_answer
from evaluation.scripts.utils.metrics import Metrics
from evaluation.scripts.utils.prompts import HOTPOT_ANSWER_PROMPT


load_dotenv()


def llm_response(
    oai_client, chat_model: str, context: str, question: str, question_date: str | None = None
) -> str:
    prompt = HOTPOT_ANSWER_PROMPT.format(question=question, context=context)
    resp = oai_client.chat.completions.create(
        model=chat_model,
        messages=[{"role": "system", "content": prompt}],
        temperature=0,
    )
    return resp.choices[0].message.content or ""


def _load_json_list(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("results"), list):
        return data.get("results") or []
    raise ValueError(f"Invalid json format: {path}")


def _save_pred(
    pred_path: Path, pred_answers: dict, pred_sp: dict, perf: dict | None = None
) -> None:
    pred_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = pred_path.with_suffix(pred_path.suffix + ".tmp")
    safe_pred_answers = {
        k: (v if isinstance(v, str) else ("" if v is None else str(v)))
        for k, v in pred_answers.items()
    }
    obj = {"answer": safe_pred_answers, "sp": pred_sp}
    if perf is not None:
        obj["perf"] = perf
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, pred_path)


def run_eval(pred_path: Path, gold_path: Path):
    spec = importlib.util.spec_from_file_location(
        "hotpot_eval_v1", "evaluation/scripts/hotpot/hotpot_evaluate_v1.py"
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    metrics = m.eval(str(pred_path), str(gold_path))

    # Save metrics to pred_path (beginning of file)
    try:
        results_path = pred_path
        current_data = {}
        if results_path.exists():
            with open(results_path, encoding="utf-8") as f:
                current_data = json.load(f)

        if isinstance(current_data, list):
            new_data = [metrics, *current_data]

        elif isinstance(current_data, dict):
            # Put metrics at the beginning
            new_data = metrics.copy()
            for k, v in current_data.items():
                if k not in new_data:
                    new_data[k] = v
        else:
            new_data = metrics

        with open(results_path, "w", encoding="utf-8") as f:
            json.dump(new_data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Failed to save metrics to {results_path}: {e}")


def evaluate_one(oai_client, row: dict, chat_model: str) -> tuple[str, str, list]:
    qid = str(row.get("_id"))
    question = row.get("question") or ""
    context = row.get("context") or ""
    sp_list = row.get("sp") or []

    raw_answer = llm_response(oai_client, chat_model, context=context, question=question)
    extracted_res = extract_answer(question, raw_answer)
    answer = parse_extracted_answer(extracted_res, raw_answer)
    return qid, answer, sp_list


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="HotpotQA eval (OpenAI only, read search results)."
    )
    parser.add_argument(
        "--lib",
        type=str,
        default="memos",
        choices=["memos", "mem0", "supermemory"],
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--max_samples", type=int, default=None)
    parser.add_argument("--version-dir", "-v", default=None, help="Version directory name")
    parser.add_argument("--chat-model", default=None, help="Chat model name")
    parser.add_argument("--search-mode", default="fine", help="Search mode")

    args = parser.parse_args(argv)

    output_dir = Path(f"evaluation/data/hotpot/{args.version_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.lib == "memos":
        search_path = output_dir / f"{args.lib}_{args.search_mode}_search_results.json"
        pred_path = output_dir / f"{args.lib}_{args.search_mode}_search_eval_results.json"
    else:
        search_path = output_dir / f"{args.lib}_search_results.json"
        pred_path = output_dir / f"{args.lib}_eval_results.json"
    gold_path = Path("evaluation/data/hotpot/dev_distractor_gold.json")

    if not search_path.exists():
        raise FileNotFoundError(f"Search results not found: {search_path}")

    if not gold_path.exists():
        load_hotpot_data("evaluation/data/hotpot")

    pred_answers: dict[str, str] = {}
    pred_sp: dict[str, list] = {}
    if pred_path.exists():
        try:
            prev = json.loads(pred_path.read_text(encoding="utf-8"))
            if isinstance(prev, dict) and isinstance(prev.get("answer"), dict):
                pred_answers.update(prev["answer"])
            if isinstance(prev, dict) and isinstance(prev.get("sp"), dict):
                pred_sp.update(prev["sp"])
        except Exception as e:
            print(f"[Eval] failed to load existing pred: {e}")

    rows = _load_json_list(search_path)
    if args.max_samples is not None:
        rows = rows[: args.max_samples]

    pending = [r for r in rows if str(r.get("_id")) not in pred_answers]
    print(f"[Eval] lib={args.lib} total={len(rows)} pending={len(pending)} workers={args.workers}")
    if not pending:
        run_eval(pred_path, gold_path)
        return

    oai_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )

    processed = len(pred_answers)

    metrics = Metrics()
    start_time = time.time()

    print("[Response model]: ", args.chat_model)
    with ThreadPoolExecutor(max_workers=args.workers) as executor:

        def do_eval(row):
            st = time.perf_counter()
            try:
                res = evaluate_one(oai_client, row, args.chat_model)
                dur = time.perf_counter() - st
                metrics.record(dur, True)
                return res
            except Exception as e:
                dur = time.perf_counter() - st
                metrics.record(dur, False, str(e))
                raise e

        futures = [executor.submit(do_eval, row) for row in pending]
        for idx, f in enumerate(
            tqdm(as_completed(futures), total=len(futures), desc="Evaluating"), 1
        ):
            try:
                qid, answer, sp_list = f.result()
                pred_answers[qid] = answer
                pred_sp[qid] = sp_list
                processed += 1
                if idx % 20 == 0:
                    _save_pred(pred_path, pred_answers, pred_sp)
            except Exception as e:
                print(f"[Eval] Error: {e}")

    _save_pred(pred_path, pred_answers, pred_sp)

    # Save performance metrics (merge into pred json)
    total_duration = time.time() - start_time
    summary = metrics.summary()
    perf_obj = {
        "summary": summary,
        "total_duration": total_duration,
        "config": {
            "workers": args.workers,
            "chat_model": args.chat_model or os.getenv("CHAT_MODEL"),
            "lib": args.lib,
        },
    }
    _save_pred(pred_path, pred_answers, pred_sp, perf=perf_obj)
    run_eval(pred_path, gold_path)

    print("\n" + "=" * 60)
    print("Evaluation finished! Statistics:")
    print("=" * 60)
    print(f"Total duration: {total_duration:.2f}s")
    print(f"Success: {summary['counts']['success']} / Failed: {summary['counts']['failed']}")

    if summary["errors"]:
        print("\nError stats:")
        for error, count in sorted(summary["errors"].items(), key=lambda x: x[1], reverse=True)[:5]:
            print(f"  [{count} times] {error[:100]}...")


if __name__ == "__main__":
    main()
