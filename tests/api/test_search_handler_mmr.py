"""Equivalence tests for the incremental MMR selection loop.

The optimized implementation maintains the per-candidate maximum similarity
to the selected set incrementally (pure comparisons via ``np.maximum``) and
precomputes stripped texts. These tests verify that its output is identical
to a reference implementation that rescans the selected set and recomputes
``strip()`` every round, across adversarial inputs (ties, near-duplicates,
negative similarities, capacity pressure).
"""

import copy
import math
import random
import uuid

from unittest.mock import MagicMock

from memos.api.handlers.search_handler import SearchHandler
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import (
    cosine_similarity_matrix,
)


def make_handler():
    handler = SearchHandler.__new__(SearchHandler)
    handler.logger = MagicMock()
    return handler


def _reference_mmr_dedup(results, text_top_k, pref_top_k=6):
    """Reference (pre-optimization) MMR selection: full rescan per round."""
    text_buckets = results.get("text_mem", [])
    pref_buckets = results.get("pref_mem", [])

    flat: list[tuple[str, int, dict, float]] = []
    for bucket_idx, bucket in enumerate(text_buckets):
        for mem in bucket.get("memories", []):
            score = mem.get("metadata", {}).get("relativity", 0.0)
            flat.append(("text", bucket_idx, mem, float(score) if score is not None else 0.0))
    for bucket_idx, bucket in enumerate(pref_buckets):
        for mem in bucket.get("memories", []):
            meta = mem.get("metadata", {})
            score = (
                meta.get("score", meta.get("relativity", 0.0)) if isinstance(meta, dict) else 0.0
            )
            flat.append(("preference", bucket_idx, mem, float(score) if score is not None else 0.0))

    if len(flat) <= 1:
        return results

    embeddings = [m.get("metadata", {}).get("embedding") for _, _, m, _ in flat]
    similarity_matrix = cosine_similarity_matrix(embeddings)

    text_indices_by_bucket = {i: [] for i in range(len(text_buckets))}
    pref_indices_by_bucket = {i: [] for i in range(len(pref_buckets))}
    for flat_index, (mem_type, bucket_idx, _, _) in enumerate(flat):
        if mem_type == "text":
            text_indices_by_bucket[bucket_idx].append(flat_index)
        elif mem_type == "preference":
            pref_indices_by_bucket[bucket_idx].append(flat_index)

    selected_global: list[int] = []
    text_selected_by_bucket = {i: [] for i in range(len(text_buckets))}
    pref_selected_by_bucket = {i: [] for i in range(len(pref_buckets))}
    selected_texts: set[str] = set()

    prefill_top_n = min(2, text_top_k, pref_top_k) if pref_buckets else min(2, text_top_k)
    ordered_by_relevance = sorted(range(len(flat)), key=lambda idx: flat[idx][3], reverse=True)
    for idx in ordered_by_relevance[: len(flat)]:
        if len(selected_global) >= prefill_top_n:
            break
        mem_type, bucket_idx, mem, _ = flat[idx]
        mem_text = mem.get("memory", "").strip()
        if mem_text in selected_texts:
            continue
        if SearchHandler._is_text_highly_similar_optimized(
            idx, mem_text, selected_global, similarity_matrix, flat, threshold=0.92
        ):
            continue
        if mem_type == "text" and len(text_selected_by_bucket[bucket_idx]) < text_top_k:
            selected_global.append(idx)
            text_selected_by_bucket[bucket_idx].append(idx)
            selected_texts.add(mem_text)
        elif mem_type == "preference" and len(pref_selected_by_bucket[bucket_idx]) < pref_top_k:
            selected_global.append(idx)
            pref_selected_by_bucket[bucket_idx].append(idx)
            selected_texts.add(mem_text)

    lambda_relevance = 0.8
    similarity_threshold = 0.9
    alpha_exponential = 10.0
    remaining = set(range(len(flat))) - set(selected_global)

    while remaining:
        best_idx: int | None = None
        best_mmr: float | None = None
        for idx in remaining:
            mem_type, bucket_idx, _, _ = flat[idx]
            if (mem_type == "text" and len(text_selected_by_bucket[bucket_idx]) >= text_top_k) or (
                mem_type == "preference" and len(pref_selected_by_bucket[bucket_idx]) >= pref_top_k
            ):
                continue
            mem_text = flat[idx][2].get("memory", "").strip()
            if mem_text in selected_texts:
                continue
            if SearchHandler._is_text_highly_similar_optimized(
                idx, mem_text, selected_global, similarity_matrix, flat, threshold=0.92
            ):
                continue
            relevance = flat[idx][3]
            max_sim = (
                0.0
                if not selected_global
                else max(similarity_matrix[idx][j] for j in selected_global)
            )
            if max_sim > similarity_threshold:
                penalty_multiplier = math.exp(alpha_exponential * (max_sim - similarity_threshold))
                diversity = max_sim * penalty_multiplier
            else:
                diversity = max_sim
            mmr_score = lambda_relevance * relevance - (1.0 - lambda_relevance) * diversity
            if best_mmr is None or mmr_score > best_mmr:
                best_mmr = mmr_score
                best_idx = idx
        if best_idx is None:
            break
        mem_type, bucket_idx, _, _ = flat[best_idx]
        selected_global.append(best_idx)
        selected_texts.add(flat[best_idx][2].get("memory", "").strip())
        if mem_type == "text":
            text_selected_by_bucket[bucket_idx].append(best_idx)
        elif mem_type == "preference":
            pref_selected_by_bucket[bucket_idx].append(best_idx)
        remaining.remove(best_idx)
        text_all_full = all(
            len(text_selected_by_bucket[b_idx]) >= min(text_top_k, len(bucket_indices))
            for b_idx, bucket_indices in text_indices_by_bucket.items()
        )
        pref_all_full = all(
            len(pref_selected_by_bucket[b_idx]) >= min(pref_top_k, len(bucket_indices))
            for b_idx, bucket_indices in pref_indices_by_bucket.items()
        )
        if text_all_full and pref_all_full:
            break

    for bucket_idx, bucket in enumerate(text_buckets):
        selected_indices = sorted(
            text_selected_by_bucket.get(bucket_idx, []), key=lambda i: flat[i][3], reverse=True
        )
        bucket["memories"] = [flat[i][2] for i in selected_indices]
    for bucket_idx, bucket in enumerate(pref_buckets):
        selected_indices = sorted(
            pref_selected_by_bucket.get(bucket_idx, []), key=lambda i: flat[i][3], reverse=True
        )
        bucket["memories"] = [flat[i][2] for i in selected_indices]
    return results


def random_unit_vec(rng, dim=16):
    v = [rng.gauss(0, 1) for _ in range(dim)]
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def perturbed_vec(rng, base, dim=16, noise=0.05):
    v = [b + rng.gauss(0, noise) for b in base]
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def make_mem(memory, score, embedding, pref=False):
    meta = {"relativity": score, "embedding": embedding}
    if pref:
        meta["score"] = score
    return {"id": str(uuid.uuid4()), "memory": memory, "metadata": meta}


def build_results(seed, n_text=54, n_pref=15, dim=16):
    """Adversarial batch: near-duplicate pairs, duplicate texts, score ties."""
    rng = random.Random(seed)
    text_buckets = [{"memories": []} for _ in range(3)]
    pref_buckets = [{"memories": []}]

    for i in range(n_text):
        emb = random_unit_vec(rng, dim)
        memory = f"text memory {seed}-{i} about project status"
        score = round(rng.uniform(0.1, 0.95), 4)
        if i % 9 == 3:  # near-duplicate embedding + near-duplicate text (gate path)
            memory = f"text memory {seed}-{i - 1} about project status."
            emb = perturbed_vec(
                rng, text_buckets[i // 18]["memories"][(i - 1) % 18]["metadata"]["embedding"], dim
            )
        if i % 11 == 5:  # exact duplicate text (selected_texts path)
            memory = f"repeated text {seed}"
        if i % 7 == 2:  # score ties
            score = 0.5
        text_buckets[i // 18]["memories"].append(make_mem(memory, score, emb))

    for i in range(n_pref):
        emb = random_unit_vec(rng, dim)
        score = round(rng.uniform(0.1, 0.95), 4)
        if i % 5 == 2:
            score = 0.5  # ties
        pref_buckets[0]["memories"].append(
            make_mem(f"preference {seed}-{i}", score, emb, pref=True)
        )

    return {"text_mem": text_buckets, "pref_mem": pref_buckets}


def assert_same_selection(actual, expected):
    for bucket_type in ("text_mem", "pref_mem"):
        a_buckets = actual.get(bucket_type, [])
        e_buckets = expected.get(bucket_type, [])
        assert len(a_buckets) == len(e_buckets)
        for a_bucket, e_bucket in zip(a_buckets, e_buckets, strict=True):
            a_ids = [m["id"] for m in a_bucket["memories"]]
            e_ids = [m["id"] for m in e_bucket["memories"]]
            assert a_ids == e_ids, f"{bucket_type} selection differs: {a_ids} vs {e_ids}"
            for a_mem, e_mem in zip(a_bucket["memories"], e_bucket["memories"], strict=True):
                assert a_mem == e_mem


def test_equivalence_mixed_batches():
    handler = make_handler()
    for seed in (1, 2, 3):
        results = build_results(seed)
        expected = _reference_mmr_dedup(copy.deepcopy(results), 3, 6)
        actual = handler._mmr_dedup_text_memories(copy.deepcopy(results), 3, 6)
        assert_same_selection(actual, expected)
        # Capacity pressure: each text bucket should be filled to text_top_k.
        total_text = sum(len(b["memories"]) for b in actual["text_mem"])
        assert total_text == min(3 * 3, 54), f"seed {seed}: unexpected text total {total_text}"


def test_equivalence_all_similar():
    """All embeddings identical + similar texts: heavy text-comparison path."""
    rng = random.Random(42)
    emb = random_unit_vec(rng)
    base_text = "the project deadline is next friday and we must deliver"
    text_buckets = [
        {
            "memories": [
                make_mem(base_text if i == 0 else base_text + f" v{i}", 0.9 - i * 0.01, emb[:])
                for i in range(8)
            ]
        }
    ]
    results = {"text_mem": text_buckets, "pref_mem": []}
    handler = make_handler()
    expected = _reference_mmr_dedup(copy.deepcopy(results), 3, 6)
    actual = handler._mmr_dedup_text_memories(copy.deepcopy(results), 3, 6)
    assert_same_selection(actual, expected)


def test_equivalence_negative_similarity():
    """Opposing vectors: negative cosines exercise the -inf initialisation."""
    rng = random.Random(7)
    vecs = [random_unit_vec(rng) for _ in range(6)]
    memories = []
    for i, v in enumerate(vecs):
        memories.append(make_mem(f"memory {i}", 0.9 - i * 0.05, v[:]))
        memories.append(make_mem(f"memory opposite {i}", 0.85 - i * 0.05, [-x for x in v]))
    results = {"text_mem": [{"memories": memories}], "pref_mem": []}
    handler = make_handler()
    expected = _reference_mmr_dedup(copy.deepcopy(results), 4, 6)
    actual = handler._mmr_dedup_text_memories(copy.deepcopy(results), 4, 6)
    assert_same_selection(actual, expected)


def test_single_memory_early_return():
    results = {"text_mem": [{"memories": [make_mem("only", 0.5, [1.0, 0.0])]}], "pref_mem": []}
    handler = make_handler()
    out = handler._mmr_dedup_text_memories(copy.deepcopy(results), 3, 6)
    assert [m["id"] for m in out["text_mem"][0]["memories"]] == [
        results["text_mem"][0]["memories"][0]["id"]
    ]


def test_running_max_bit_identical():
    """Incremental np.maximum maintenance equals full rescan, bit for bit."""
    import numpy as np

    rng = random.Random(11)
    n = 30
    matrix = cosine_similarity_matrix([random_unit_vec(rng) for _ in range(n)])
    order = list(range(n))
    rng.shuffle(order)

    selected = []
    running_max = np.full(n, -np.inf)
    for idx in order:
        # Full rescan ground truth for every candidate.
        for cand in range(n):
            expected = max(matrix[cand][j] for j in selected) if selected else None
            actual = running_max[cand] if selected else None
            if expected is not None:
                assert actual == expected, f"cand={cand}: {actual} != {expected}"
        selected.append(idx)
        np.maximum(running_max, matrix[:, idx], out=running_max)
