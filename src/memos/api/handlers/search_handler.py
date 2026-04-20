"""
Search handler for memory search functionality (Class-based version).

This module provides a class-based implementation of search handlers,
using dependency injection for better modularity and testability.
"""

import copy
import math
import os

from typing import Any

from fastapi import HTTPException

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.handlers.formatters_handler import rerank_knowledge_mem
from memos.api.middleware.agent_auth import get_authenticated_user
from memos.api.product_models import APISearchRequest, SearchResponse
from memos.log import get_logger
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import (
    cosine_similarity_matrix,
)
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.multi_mem_cube.views import MemCubeView


logger = get_logger(__name__)


class SearchHandler(BaseHandler):
    """
    Handler for memory search operations.

    Provides fast, fine-grained, and mixture-based search modes.
    """

    def __init__(self, dependencies: HandlerDependencies):
        """
        Initialize search handler.

        Args:
            dependencies: HandlerDependencies instance
        """
        super().__init__(dependencies)
        self._validate_dependencies(
            "naive_mem_cube", "mem_scheduler", "searcher", "deepsearch_agent"
        )

    def handle_search_memories(self, search_req: APISearchRequest) -> SearchResponse:
        """
        Main handler for search memories endpoint.

        Orchestrates the search process based on the requested search mode,
        supporting text memory searches.

        Args:
            search_req: Search request containing query and parameters

        Returns:
            SearchResponse with formatted results
        """
        self.logger.info(f"[SearchHandler] Search Req is: {search_req}")

        # Auth spoof check: if a key was presented, user_id must match what the key says
        authenticated = get_authenticated_user()
        if authenticated is not None and authenticated != search_req.user_id:
            raise HTTPException(
                status_code=403,
                detail=f"Key authenticated as '{authenticated}' but request claims user_id='{search_req.user_id}'. Spoofing not allowed."
            )

        # Cube isolation: verify user has access to all requested cubes
        user_manager = getattr(self.deps, "user_manager", None)
        if user_manager:
            cube_ids = self._resolve_cube_ids(search_req)
            for cube_id in cube_ids:
                if not user_manager.validate_user_cube_access(search_req.user_id, cube_id):
                    raise HTTPException(
                        status_code=403,
                        detail=f"Access denied: user '{search_req.user_id}' cannot read cube '{cube_id}'"
                    )

        # Use deepcopy to avoid modifying the original request object
        search_req_local = copy.deepcopy(search_req)

        # Expand top_k for deduplication (env-configurable, default 5x)
        _top_k_factor = int(os.getenv("MOS_SEARCH_TOP_K_FACTOR", "5"))
        if search_req_local.dedup in ("sim", "mmr"):
            search_req_local.top_k = search_req_local.top_k * _top_k_factor

        # Search and deduplicate
        cube_view = self._build_cube_view(search_req_local)
        results = cube_view.search_memories(search_req_local)
        if not search_req_local.relativity:
            search_req_local.relativity = 0
        self.logger.info(f"[SearchHandler] Relativity filter: {search_req_local.relativity}")
        results = self._apply_relativity_threshold(results, search_req_local.relativity)

        if search_req_local.dedup == "no":
            self._strip_embeddings(results)
        elif search_req_local.dedup == "sim":
            results = self._dedup_text_memories(results, search_req.top_k)
            self._strip_embeddings(results)
        elif search_req_local.dedup == "mmr":
            pref_top_k = getattr(search_req_local, "pref_top_k", 6)
            results = self._mmr_dedup_text_memories(results, search_req.top_k, pref_top_k)
            self._strip_embeddings(results)

        text_mem = results["text_mem"]
        results["text_mem"] = rerank_knowledge_mem(
            self.reranker,
            query=search_req.query,
            text_mem=text_mem,
            top_k=search_req.top_k,
            file_mem_proportion=0.5,
        )

        self.logger.info(
            f"[SearchHandler] Final search results: count={len(results)} results={results}"
        )

        return SearchResponse(
            message="Search completed successfully",
            data=results,
        )

    @staticmethod
    def _apply_relativity_threshold(results: dict[str, Any], relativity: float) -> dict[str, Any]:
        if relativity <= 0:
            return results

        for key in ("text_mem", "pref_mem"):
            buckets = results.get(key)
            if not isinstance(buckets, list):
                continue

            for bucket in buckets:
                memories = bucket.get("memories")
                if not isinstance(memories, list):
                    continue

                filtered: list[dict[str, Any]] = []
                for mem in memories:
                    if not isinstance(mem, dict):
                        continue
                    meta = mem.get("metadata", {})
                    score = meta.get("relativity", 1.0) if isinstance(meta, dict) else 1.0
                    try:
                        score_val = float(score) if score is not None else 1.0
                    except (TypeError, ValueError):
                        score_val = 1.0
                    if score_val >= relativity:
                        filtered.append(mem)

                bucket["memories"] = filtered
                if "total_nodes" in bucket:
                    bucket["total_nodes"] = len(filtered)

        return results

    def _dedup_text_memories(self, results: dict[str, Any], target_top_k: int) -> dict[str, Any]:
        """
        Similarity-based dedup: pairwise cosine filter.

        Iterate candidates in (relativity desc, idx asc) order; skip any whose
        cosine similarity >= MOS_MMR_TEXT_THRESHOLD to an already-selected
        candidate. Cap each bucket at target_top_k.
        """
        buckets = results.get("text_mem", [])
        if not buckets:
            return results

        threshold = float(os.getenv("MOS_MMR_TEXT_THRESHOLD", "0.85"))

        flat: list[tuple[int, dict[str, Any], float]] = []
        for bucket_idx, bucket in enumerate(buckets):
            for mem in bucket.get("memories", []):
                score = mem.get("metadata", {}).get("relativity", 0.0)
                try:
                    score_val = float(score) if score is not None else 0.0
                except (TypeError, ValueError):
                    score_val = 0.0
                flat.append((bucket_idx, mem, score_val))

        if len(flat) <= 1:
            return results

        embeddings = self._extract_embeddings([mem for _, mem, _ in flat])
        similarity_matrix = cosine_similarity_matrix(embeddings)

        ordered_indices = sorted(range(len(flat)), key=lambda idx: (-flat[idx][2], idx))

        selected_global: list[int] = []
        selected_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(buckets))}

        for idx in ordered_indices:
            bucket_idx = flat[idx][0]
            if len(selected_by_bucket[bucket_idx]) >= target_top_k:
                continue
            if any(similarity_matrix[idx][j] >= threshold for j in selected_global):
                continue
            selected_by_bucket[bucket_idx].append(idx)
            selected_global.append(idx)

        for bucket_idx, bucket in enumerate(buckets):
            selected_indices = selected_by_bucket.get(bucket_idx, [])
            selected_indices = sorted(selected_indices, key=lambda i: (-flat[i][2], i))
            bucket["memories"] = [flat[i][1] for i in selected_indices]
        return results

    def _mmr_dedup_text_memories(
        self, results: dict[str, Any], text_top_k: int, pref_top_k: int = 6
    ) -> dict[str, Any]:
        """
        MMR-based deduplication across text_mem and pref_mem buckets.

        Score each candidate as:
            mmr = λ * relevance − (1 − λ) * diversity
        where diversity = max_sim to selected, inflated by an exponential
        penalty when max_sim > MOS_MMR_PENALTY_THRESHOLD. Tiebreak on
        (relevance desc, idx asc) for determinism.
        """
        text_buckets = results.get("text_mem", [])
        pref_buckets = results.get("pref_mem", [])

        if not text_buckets and not pref_buckets:
            return results

        # flat structure: (memory_type, bucket_idx, mem, score)
        flat: list[tuple[str, int, dict[str, Any], float]] = []

        for bucket_idx, bucket in enumerate(text_buckets):
            for mem in bucket.get("memories", []):
                score = mem.get("metadata", {}).get("relativity", 0.0)
                flat.append(("text", bucket_idx, mem, float(score) if score is not None else 0.0))

        for bucket_idx, bucket in enumerate(pref_buckets):
            for mem in bucket.get("memories", []):
                meta = mem.get("metadata", {})
                if isinstance(meta, dict):
                    score = meta.get("score", meta.get("relativity", 0.0))
                else:
                    score = 0.0
                flat.append(
                    ("preference", bucket_idx, mem, float(score) if score is not None else 0.0)
                )

        if len(flat) <= 1:
            return results

        embeddings = self._extract_embeddings([mem for _, _, mem, _ in flat])
        similarity_matrix = cosine_similarity_matrix(embeddings)

        lambda_relevance = float(os.getenv("MOS_MMR_LAMBDA", "0.7"))
        penalty_threshold = float(os.getenv("MOS_MMR_PENALTY_THRESHOLD", "0.7"))
        alpha_exponential = 10.0

        def bucket_has_capacity(mem_type: str, bucket_idx: int) -> bool:
            if mem_type == "text":
                return len(text_selected_by_bucket[bucket_idx]) < text_top_k
            if mem_type == "preference":
                return len(pref_selected_by_bucket[bucket_idx]) < pref_top_k
            return False

        text_selected_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(text_buckets))}
        pref_selected_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(pref_buckets))}
        selected_global: list[int] = []
        remaining = sorted(range(len(flat)))

        while remaining:
            best_idx: int | None = None
            best_mmr: float | None = None
            best_relevance: float | None = None

            for idx in remaining:
                mem_type, bucket_idx, _, relevance = flat[idx]
                if not bucket_has_capacity(mem_type, bucket_idx):
                    continue

                if not selected_global:
                    max_sim = 0.0
                else:
                    max_sim = max(similarity_matrix[idx][j] for j in selected_global)

                if max_sim > penalty_threshold:
                    diversity = max_sim * math.exp(
                        alpha_exponential * (max_sim - penalty_threshold)
                    )
                else:
                    diversity = max_sim

                mmr_score = lambda_relevance * relevance - (1.0 - lambda_relevance) * diversity

                # Deterministic tiebreak: relevance desc, then idx asc.
                # (remaining is already sorted by idx, so the first winner wins ties on idx.)
                if (
                    best_mmr is None
                    or mmr_score > best_mmr
                    or (mmr_score == best_mmr and relevance > (best_relevance or 0.0))
                ):
                    best_mmr = mmr_score
                    best_idx = idx
                    best_relevance = relevance

            if best_idx is None:
                break

            mem_type, bucket_idx, _, _ = flat[best_idx]
            selected_global.append(best_idx)
            if mem_type == "text":
                text_selected_by_bucket[bucket_idx].append(best_idx)
            elif mem_type == "preference":
                pref_selected_by_bucket[bucket_idx].append(best_idx)
            remaining.remove(best_idx)

        for bucket_idx, bucket in enumerate(text_buckets):
            selected_indices = text_selected_by_bucket.get(bucket_idx, [])
            selected_indices = sorted(selected_indices, key=lambda i: (-flat[i][3], i))
            bucket["memories"] = [flat[i][2] for i in selected_indices]

        for bucket_idx, bucket in enumerate(pref_buckets):
            selected_indices = pref_selected_by_bucket.get(bucket_idx, [])
            selected_indices = sorted(selected_indices, key=lambda i: (-flat[i][3], i))
            bucket["memories"] = [flat[i][2] for i in selected_indices]

        return results

    @staticmethod
    def _is_unrelated(
        index: int,
        selected_indices: list[int],
        similarity_matrix: list[list[float]],
        similarity_threshold: float,
    ) -> bool:
        return all(similarity_matrix[index][j] <= similarity_threshold for j in selected_indices)

    @staticmethod
    def _max_similarity(
        index: int, selected_indices: list[int], similarity_matrix: list[list[float]]
    ) -> float:
        if not selected_indices:
            return 0.0
        return max(similarity_matrix[index][j] for j in selected_indices)

    def _extract_embeddings(self, memories: list[dict[str, Any]]) -> list[list[float]]:
        embeddings: list[list[float]] = []
        missing_indices: list[int] = []
        missing_documents: list[str] = []

        for idx, mem in enumerate(memories):
            metadata = mem.get("metadata")
            if not isinstance(metadata, dict):
                metadata = {}
                mem["metadata"] = metadata

            embedding = metadata.get("embedding")
            if embedding:
                embeddings.append(embedding)
                continue

            embeddings.append([])
            missing_indices.append(idx)
            missing_documents.append(mem.get("memory", ""))

        if missing_indices:
            computed = self.searcher.embedder.embed(missing_documents)
            for idx, embedding in zip(missing_indices, computed, strict=False):
                embeddings[idx] = embedding
                memories[idx]["metadata"]["embedding"] = embedding

        return embeddings

    @staticmethod
    def _strip_embeddings(results: dict[str, Any]) -> None:
        for _mem_type, mem_results in results.items():
            if isinstance(mem_results, list):
                for bucket in mem_results:
                    for mem in bucket.get("memories", []):
                        metadata = mem.get("metadata", {})
                        if "embedding" in metadata:
                            metadata["embedding"] = []

    @staticmethod
    def _dice_similarity(text1: str, text2: str) -> float:
        """
        Calculate Dice coefficient (character-level, fastest).

        Dice = 2 * |A ∩ B| / (|A| + |B|)
        Speed: O(n + m), ~0.05-0.1ms per comparison

        Args:
            text1: First text string
            text2: Second text string

        Returns:
            Dice similarity score between 0.0 and 1.0
        """
        if not text1 or not text2:
            return 0.0

        chars1 = set(text1)
        chars2 = set(text2)

        intersection = len(chars1 & chars2)
        return 2 * intersection / (len(chars1) + len(chars2))

    @staticmethod
    def _bigram_similarity(text1: str, text2: str) -> float:
        """
        Calculate character-level 2-gram Jaccard similarity.

        Speed: O(n + m), ~0.1-0.2ms per comparison
        Considers local order (more strict than Dice).

        Args:
            text1: First text string
            text2: Second text string

        Returns:
            Jaccard similarity score between 0.0 and 1.0
        """
        if not text1 or not text2:
            return 0.0

        # Generate 2-grams
        bigrams1 = {text1[i : i + 2] for i in range(len(text1) - 1)} if len(text1) >= 2 else {text1}
        bigrams2 = {text2[i : i + 2] for i in range(len(text2) - 1)} if len(text2) >= 2 else {text2}

        intersection = len(bigrams1 & bigrams2)
        union = len(bigrams1 | bigrams2)

        return intersection / union if union > 0 else 0.0

    @staticmethod
    def _tfidf_similarity(text1: str, text2: str) -> float:
        """
        Calculate TF-IDF cosine similarity (character-level, no sklearn).

        Speed: O(n + m), ~0.3-0.5ms per comparison
        Considers character frequency weighting.

        Args:
            text1: First text string
            text2: Second text string

        Returns:
            Cosine similarity score between 0.0 and 1.0
        """
        if not text1 or not text2:
            return 0.0

        from collections import Counter

        # Character frequency (TF)
        tf1 = Counter(text1)
        tf2 = Counter(text2)

        # All unique characters (vocabulary)
        vocab = set(tf1.keys()) | set(tf2.keys())

        # Simple IDF: log(2 / df) where df is document frequency
        # For two documents, IDF is log(2/1)=0.693 if char appears in one doc,
        # or log(2/2)=0 if appears in both (we use log(2/1) for simplicity)
        idf = {char: (1.0 if char in tf1 and char in tf2 else 1.5) for char in vocab}

        # TF-IDF vectors
        vec1 = {char: tf1.get(char, 0) * idf[char] for char in vocab}
        vec2 = {char: tf2.get(char, 0) * idf[char] for char in vocab}

        # Cosine similarity
        dot_product = sum(vec1[char] * vec2[char] for char in vocab)
        norm1 = math.sqrt(sum(v * v for v in vec1.values()))
        norm2 = math.sqrt(sum(v * v for v in vec2.values()))

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return dot_product / (norm1 * norm2)

    @staticmethod
    def _is_text_highly_similar_optimized(
        candidate_idx: int,
        candidate_text: str,
        selected_global: list[int],
        similarity_matrix,
        flat: list,
        threshold: float = 0.9,
    ) -> bool:
        """
        Multi-algorithm text similarity check with embedding pre-filtering.

        Strategy:
        1. Only compare with the single highest embedding similarity item (not all 25)
        2. Only perform text comparison if embedding similarity > 0.60
        3. Use weighted combination of three algorithms:
           - Dice (40%): Fastest, character-level set similarity
           - TF-IDF (35%): Considers character frequency weighting
           - 2-gram (25%): Considers local character order

        Combined formula:
            combined_score = 0.40 * dice + 0.35 * tfidf + 0.25 * bigram

        This reduces comparisons from O(N) to O(1) per candidate, with embedding pre-filtering.
        Expected speedup: 100-200x compared to LCS approach.

        Args:
            candidate_idx: Index of candidate memory in flat list
            candidate_text: Text content of candidate memory
            selected_global: List of already selected memory indices
            similarity_matrix: Precomputed embedding similarity matrix
            flat: Flat list of all memories
            threshold: Combined similarity threshold (default 0.75)

        Returns:
            True if candidate is highly similar to any selected memory
        """
        if not selected_global:
            return False

        # Find the already-selected memory with highest embedding similarity
        max_sim_idx = max(selected_global, key=lambda j: similarity_matrix[candidate_idx][j])
        max_sim = similarity_matrix[candidate_idx][max_sim_idx]

        # If highest embedding similarity < 0.60, skip text comparison entirely
        if max_sim <= 0.9:
            return False

        # Get text of most similar memory
        most_similar_mem = flat[max_sim_idx][2]
        most_similar_text = most_similar_mem.get("memory", "").strip()

        # Calculate three similarity scores
        dice_sim = SearchHandler._dice_similarity(candidate_text, most_similar_text)
        tfidf_sim = SearchHandler._tfidf_similarity(candidate_text, most_similar_text)
        bigram_sim = SearchHandler._bigram_similarity(candidate_text, most_similar_text)

        # Weighted combination: Dice (40%) + TF-IDF (35%) + 2-gram (25%)
        # Dice has highest weight (fastest and most reliable)
        # TF-IDF considers frequency (handles repeated characters well)
        # 2-gram considers order (catches local pattern similarity)
        combined_score = 0.40 * dice_sim + 0.35 * tfidf_sim + 0.25 * bigram_sim

        return combined_score >= threshold

    @staticmethod
    def _dice_similarity(text1: str, text2: str) -> float:
        """
        Calculate Dice coefficient (character-level, fastest).

        Dice = 2 * |A ∩ B| / (|A| + |B|)
        Speed: O(n + m), ~0.05-0.1ms per comparison

        Args:
            text1: First text string
            text2: Second text string

        Returns:
            Dice similarity score between 0.0 and 1.0
        """
        if not text1 or not text2:
            return 0.0

        chars1 = set(text1)
        chars2 = set(text2)

        intersection = len(chars1 & chars2)
        return 2 * intersection / (len(chars1) + len(chars2))

    @staticmethod
    def _bigram_similarity(text1: str, text2: str) -> float:
        """
        Calculate character-level 2-gram Jaccard similarity.

        Speed: O(n + m), ~0.1-0.2ms per comparison
        Considers local order (more strict than Dice).

        Args:
            text1: First text string
            text2: Second text string

        Returns:
            Jaccard similarity score between 0.0 and 1.0
        """
        if not text1 or not text2:
            return 0.0

        # Generate 2-grams
        bigrams1 = {text1[i : i + 2] for i in range(len(text1) - 1)} if len(text1) >= 2 else {text1}
        bigrams2 = {text2[i : i + 2] for i in range(len(text2) - 1)} if len(text2) >= 2 else {text2}

        intersection = len(bigrams1 & bigrams2)
        union = len(bigrams1 | bigrams2)

        return intersection / union if union > 0 else 0.0

    @staticmethod
    def _tfidf_similarity(text1: str, text2: str) -> float:
        """
        Calculate TF-IDF cosine similarity (character-level, no sklearn).

        Speed: O(n + m), ~0.3-0.5ms per comparison
        Considers character frequency weighting.

        Args:
            text1: First text string
            text2: Second text string

        Returns:
            Cosine similarity score between 0.0 and 1.0
        """
        if not text1 or not text2:
            return 0.0

        from collections import Counter

        # Character frequency (TF)
        tf1 = Counter(text1)
        tf2 = Counter(text2)

        # All unique characters (vocabulary)
        vocab = set(tf1.keys()) | set(tf2.keys())

        # Simple IDF: log(2 / df) where df is document frequency
        # For two documents, IDF is log(2/1)=0.693 if char appears in one doc,
        # or log(2/2)=0 if appears in both (we use log(2/1) for simplicity)
        idf = {char: (1.0 if char in tf1 and char in tf2 else 1.5) for char in vocab}

        # TF-IDF vectors
        vec1 = {char: tf1.get(char, 0) * idf[char] for char in vocab}
        vec2 = {char: tf2.get(char, 0) * idf[char] for char in vocab}

        # Cosine similarity
        dot_product = sum(vec1[char] * vec2[char] for char in vocab)
        norm1 = math.sqrt(sum(v * v for v in vec1.values()))
        norm2 = math.sqrt(sum(v * v for v in vec2.values()))

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return dot_product / (norm1 * norm2)

    @staticmethod
    def _is_text_highly_similar_optimized(
        candidate_idx: int,
        candidate_text: str,
        selected_global: list[int],
        similarity_matrix,
        flat: list,
        threshold: float = 0.92,
    ) -> bool:
        """
        Multi-algorithm text similarity check with embedding pre-filtering.

        Strategy:
        1. Only compare with the single highest embedding similarity item (not all 25)
        2. Only perform text comparison if embedding similarity > 0.60
        3. Use weighted combination of three algorithms:
           - Dice (40%): Fastest, character-level set similarity
           - TF-IDF (35%): Considers character frequency weighting
           - 2-gram (25%): Considers local character order

        Combined formula:
            combined_score = 0.40 * dice + 0.35 * tfidf + 0.25 * bigram

        This reduces comparisons from O(N) to O(1) per candidate, with embedding pre-filtering.
        Expected speedup: 100-200x compared to LCS approach.

        Args:
            candidate_idx: Index of candidate memory in flat list
            candidate_text: Text content of candidate memory
            selected_global: List of already selected memory indices
            similarity_matrix: Precomputed embedding similarity matrix
            flat: Flat list of all memories
            threshold: Combined similarity threshold (default 0.75)

        Returns:
            True if candidate is highly similar to any selected memory
        """
        if not selected_global:
            return False

        # Find the already-selected memory with highest embedding similarity
        max_sim_idx = max(selected_global, key=lambda j: similarity_matrix[candidate_idx][j])
        max_sim = similarity_matrix[candidate_idx][max_sim_idx]

        # If highest embedding similarity < 0.60, skip text comparison entirely
        if max_sim <= 0.9:
            return False

        # Get text of most similar memory
        most_similar_mem = flat[max_sim_idx][2]
        most_similar_text = most_similar_mem.get("memory", "").strip()

        # Calculate three similarity scores
        dice_sim = SearchHandler._dice_similarity(candidate_text, most_similar_text)
        tfidf_sim = SearchHandler._tfidf_similarity(candidate_text, most_similar_text)
        bigram_sim = SearchHandler._bigram_similarity(candidate_text, most_similar_text)

        # Weighted combination: Dice (40%) + TF-IDF (35%) + 2-gram (25%)
        # Dice has highest weight (fastest and most reliable)
        # TF-IDF considers frequency (handles repeated characters well)
        # 2-gram considers order (catches local pattern similarity)
        combined_score = 0.40 * dice_sim + 0.35 * tfidf_sim + 0.25 * bigram_sim

        return combined_score >= threshold

    def _resolve_cube_ids(self, search_req: APISearchRequest) -> list[str]:
        """
        Normalize target cube ids from search_req.
        Priority:
        1) readable_cube_ids (deprecated mem_cube_id is converted to this in model validator)
        2) fallback to user_id
        """
        if search_req.readable_cube_ids:
            return list(dict.fromkeys(search_req.readable_cube_ids))

        return [search_req.user_id]

    def _build_cube_view(self, search_req: APISearchRequest, searcher=None) -> MemCubeView:
        cube_ids = self._resolve_cube_ids(search_req)
        searcher_to_use = searcher if searcher is not None else self.searcher

        if len(cube_ids) == 1:
            cube_id = cube_ids[0]
            return SingleCubeView(
                cube_id=cube_id,
                naive_mem_cube=self.naive_mem_cube,
                mem_reader=self.mem_reader,
                mem_scheduler=self.mem_scheduler,
                logger=self.logger,
                searcher=searcher_to_use,
                deepsearch_agent=self.deepsearch_agent,
            )
        else:
            single_views = [
                SingleCubeView(
                    cube_id=cube_id,
                    naive_mem_cube=self.naive_mem_cube,
                    mem_reader=self.mem_reader,
                    mem_scheduler=self.mem_scheduler,
                    logger=self.logger,
                    searcher=searcher_to_use,
                    deepsearch_agent=self.deepsearch_agent,
                )
                for cube_id in cube_ids
            ]
            return CompositeCubeView(cube_views=single_views, logger=self.logger)
