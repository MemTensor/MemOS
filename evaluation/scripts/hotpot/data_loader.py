import json

from pathlib import Path

from datasets import load_dataset


def load_hotpot_data(data_dir: Path | str) -> list[dict]:
    """
    Load HotpotQA dataset.
    If dev_distractor_gold.json exists in data_dir, load it.
    Otherwise, download from Hugging Face, convert to standard format, save, and load.
    """
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    file_path = data_dir / "dev_distractor_gold.json"

    if file_path.exists():
        print(f"Loading local dataset from {file_path}")
        try:
            with open(file_path, encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Failed to load local file: {e}. Re-downloading...")

    print("Downloading HotpotQA dataset from Hugging Face...")
    try:
        dataset = load_dataset(
            "hotpotqa/hotpot_qa", "distractor", split="validation", trust_remote_code=True
        )
    except Exception as e:
        print(f"Failed to download dataset: {e}")
        raise

    print(f"Processing and saving dataset to {file_path}...")
    items = []
    for item in dataset:
        # Convert HF format to Standard format
        # ID
        qid = item.get("id") or item.get("_id")

        # Supporting Facts
        sp = item.get("supporting_facts")
        if isinstance(sp, dict):
            sp_titles = sp.get("title", [])
            sp_sent_ids = sp.get("sent_id", [])
            sp_list = list(zip(sp_titles, sp_sent_ids, strict=False))
        else:
            sp_list = sp or []

        # Context
        ctx = item.get("context")
        if isinstance(ctx, dict):
            ctx_titles = ctx.get("title", [])
            ctx_sentences = ctx.get("sentences", [])
            ctx_list = list(zip(ctx_titles, ctx_sentences, strict=False))
        else:
            ctx_list = ctx or []

        new_item = {
            "_id": qid,
            "question": item.get("question"),
            "answer": item.get("answer"),
            "supporting_facts": sp_list,
            "context": ctx_list,
            "type": item.get("type"),
            "level": item.get("level"),
        }
        items.append(new_item)

    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        print(f"Saved {len(items)} items to {file_path}")
    except Exception as e:
        print(f"Failed to save dataset: {e}")

    return items
