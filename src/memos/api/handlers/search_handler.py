"""
Search handler for memory search functionality (Class-based version).

This module provides a class-based implementation of search handlers,
using dependency injection for better modularity and testability.
"""

import copy
import math

from typing import Any

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
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
        supporting both text and preference memory searches.

        Args:
            search_req: Search request containing query and parameters

        Returns:
            SearchResponse with formatted results
        """
        self.logger.info(f"[SearchHandler] Search Req is: {search_req}")

        # Use deepcopy to avoid modifying the original request object
        search_req_local = copy.deepcopy(search_req)
        original_top_k = search_req_local.top_k

        # Expand top_k for deduplication (5x to ensure enough candidates)
        if search_req_local.dedup in ("sim", "mmr"):
            search_req_local.top_k = original_top_k * 5

        # Create new searcher with include_embedding for MMR deduplication
        searcher_to_use = self.searcher
        if search_req_local.dedup == "mmr":
            text_mem = getattr(self.naive_mem_cube, "text_mem", None)
            if text_mem is not None:
                # Create new searcher instance with include_embedding=True
                searcher_to_use = text_mem.get_searcher(
                    manual_close_internet=not getattr(self.searcher, "internet_retriever", None),
                    moscube=False,
                    process_llm=getattr(self.mem_reader, "llm", None),
                )
                # Override include_embedding for this searcher
                if hasattr(searcher_to_use, "graph_retriever"):
                    searcher_to_use.graph_retriever.include_embedding = True

        # Search and deduplicate
        cube_view = self._build_cube_view(search_req_local, searcher_to_use)
        results = cube_view.search_memories(search_req_local)

        if search_req_local.dedup == "sim":
            results = self._dedup_text_memories(results, original_top_k)
            self._strip_embeddings(results)
        elif search_req_local.dedup == "mmr":
            pref_top_k = getattr(search_req_local, "pref_top_k", 6)
            results = self._mmr_dedup_text_memories(results, original_top_k, pref_top_k)
            self._strip_embeddings(results)

        self.logger.info(
            f"[SearchHandler] Final search results: count={len(results)} results={results}"
        )

        return SearchResponse(
            message="Search completed successfully",
            data=results,
        )

    def _dedup_text_memories(self, results: dict[str, Any], target_top_k: int) -> dict[str, Any]:
        buckets = results.get("text_mem", [])
        if not buckets:
            return results

        flat: list[tuple[int, dict[str, Any], float]] = []
        for bucket_idx, bucket in enumerate(buckets):
            for mem in bucket.get("memories", []):
                score = mem.get("metadata", {}).get("relativity", 0.0)
                flat.append((bucket_idx, mem, score))

        if len(flat) <= 1:
            return results

        embeddings = self._extract_embeddings([mem for _, mem, _ in flat])
        if embeddings is None:
            documents = [mem.get("memory", "") for _, mem, _ in flat]
            embeddings = self.searcher.embedder.embed(documents)

        similarity_matrix = cosine_similarity_matrix(embeddings)

        indices_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(buckets))}
        for flat_index, (bucket_idx, _, _) in enumerate(flat):
            indices_by_bucket[bucket_idx].append(flat_index)

        selected_global: list[int] = []
        selected_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(buckets))}

        ordered_indices = sorted(range(len(flat)), key=lambda idx: flat[idx][2], reverse=True)
        for idx in ordered_indices:
            bucket_idx = flat[idx][0]
            if len(selected_by_bucket[bucket_idx]) >= target_top_k:
                continue
            # Use 0.92 threshold strictly
            if self._is_unrelated(idx, selected_global, similarity_matrix, 0.92):
                selected_by_bucket[bucket_idx].append(idx)
                selected_global.append(idx)

        # Removed the 'filling' logic that was pulling back similar items.
        # Now it will only return items that truly pass the 0.92 threshold,
        # up to target_top_k.

        for bucket_idx, bucket in enumerate(buckets):
            selected_indices = selected_by_bucket.get(bucket_idx, [])
            bucket["memories"] = [flat[i][1] for i in selected_indices]
        return results

    def _mmr_dedup_text_memories(
        self, results: dict[str, Any], text_top_k: int, pref_top_k: int = 6
    ) -> dict[str, Any]:
        """
        MMR-based deduplication with progressive penalty for high similarity.

        Performs deduplication on both text_mem and preference memories together.
        Other memory types (tool_mem, etc.) are not modified.

        Args:
            results: Search results containing text_mem and preference buckets
            text_top_k: Target number of text memories to return per bucket
            pref_top_k: Target number of preference memories to return per bucket

        Algorithm:
        1. Prefill top 5 by relevance
        2. MMR selection: balance relevance vs diversity
        3. Re-sort by original relevance for better generation quality
        """
        text_buckets = results.get("text_mem", [])
        pref_buckets = results.get("preference", [])

        # Early return if no memories to deduplicate
        if not text_buckets and not pref_buckets:
            return results

        # Flatten all memories with their type and scores
        # flat structure: (memory_type, bucket_idx, mem, score)
        flat: list[tuple[str, int, dict[str, Any], float]] = []

        # Flatten text memories
        for bucket_idx, bucket in enumerate(text_buckets):
            for mem in bucket.get("memories", []):
                score = mem.get("metadata", {}).get("relativity", 0.0)
                flat.append(("text", bucket_idx, mem, float(score) if score is not None else 0.0))

        # Flatten preference memories
        for bucket_idx, bucket in enumerate(pref_buckets):
            for mem in bucket.get("memories", []):
                score = mem.get("metadata", {}).get("relativity", 0.0)
                flat.append(
                    ("preference", bucket_idx, mem, float(score) if score is not None else 0.0)
                )

        if len(flat) <= 1:
            return results

        # Get or compute embeddings
        embeddings = self._extract_embeddings([mem for _, _, mem, _ in flat])
        if embeddings is None:
            self.logger.warning("[SearchHandler] Embedding is missing; recomputing embeddings")
            documents = [mem.get("memory", "") for _, _, mem, _ in flat]
            embeddings = self.searcher.embedder.embed(documents)

        # Compute similarity matrix using NumPy-optimized method
        # Returns numpy array but compatible with list[i][j] indexing
        similarity_matrix = cosine_similarity_matrix(embeddings)

        # Initialize selection tracking for both text and preference
        text_indices_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(text_buckets))}
        pref_indices_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(pref_buckets))}

        for flat_index, (mem_type, bucket_idx, _, _) in enumerate(flat):
            if mem_type == "text":
                text_indices_by_bucket[bucket_idx].append(flat_index)
            elif mem_type == "preference":
                pref_indices_by_bucket[bucket_idx].append(flat_index)

        selected_global: list[int] = []
        text_selected_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(text_buckets))}
        pref_selected_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(pref_buckets))}
        selected_texts: set[str] = set()  # Track exact text content to avoid duplicates

        # Phase 1: Prefill top N by relevance
        # Use the smaller of text_top_k and pref_top_k for prefill count
        prefill_top_n = min(2, text_top_k, pref_top_k) if pref_buckets else min(2, text_top_k)
        ordered_by_relevance = sorted(range(len(flat)), key=lambda idx: flat[idx][3], reverse=True)
        for idx in ordered_by_relevance[: len(flat)]:
            if len(selected_global) >= prefill_top_n:
                break
            mem_type, bucket_idx, mem, _ = flat[idx]

            # Skip if exact text already exists in selected set
            mem_text = mem.get("memory", "").strip()
            if mem_text in selected_texts:
                continue

            # Skip if highly similar (Dice + TF-IDF + 2-gram combined, with embedding filter)
            if SearchHandler._is_text_highly_similar_optimized(
                idx, mem_text, selected_global, similarity_matrix, flat, threshold=0.9
            ):
                continue

            # Check bucket capacity with correct top_k for each type
            if mem_type == "text" and len(text_selected_by_bucket[bucket_idx]) < text_top_k:
                selected_global.append(idx)
                text_selected_by_bucket[bucket_idx].append(idx)
                selected_texts.add(mem_text)
            elif mem_type == "preference" and len(pref_selected_by_bucket[bucket_idx]) < pref_top_k:
                selected_global.append(idx)
                pref_selected_by_bucket[bucket_idx].append(idx)
                selected_texts.add(mem_text)

        # Phase 2: MMR selection for remaining slots
        lambda_relevance = 0.8
        similarity_threshold = 0.9  # Start exponential penalty from 0.9 (lowered from 0.9)
        alpha_exponential = 10.0  # Exponential penalty coefficient
        remaining = set(range(len(flat))) - set(selected_global)

        while remaining:
            best_idx: int | None = None
            best_mmr: float | None = None

            for idx in remaining:
                mem_type, bucket_idx, mem, _ = flat[idx]

                # Check bucket capacity with correct top_k for each type
                if (
                    mem_type == "text" and len(text_selected_by_bucket[bucket_idx]) >= text_top_k
                ) or (
                    mem_type == "preference"
                    and len(pref_selected_by_bucket[bucket_idx]) >= pref_top_k
                ):
                    continue

                # Check if exact text already exists - if so, skip this candidate entirely
                mem_text = mem.get("memory", "").strip()
                if mem_text in selected_texts:
                    continue  # Skip duplicate text, don't participate in MMR competition

                # Skip if highly similar (Dice + TF-IDF + 2-gram combined, with embedding filter)
                if SearchHandler._is_text_highly_similar_optimized(
                    idx, mem_text, selected_global, similarity_matrix, flat, threshold=0.9
                ):
                    continue  # Skip highly similar text, don't participate in MMR competition

                relevance = flat[idx][3]
                max_sim = (
                    0.0
                    if not selected_global
                    else max(similarity_matrix[idx][j] for j in selected_global)
                )

                # Exponential penalty for similarity > 0.80
                if max_sim > similarity_threshold:
                    penalty_multiplier = math.exp(
                        alpha_exponential * (max_sim - similarity_threshold)
                    )
                    diversity = max_sim * penalty_multiplier
                else:
                    diversity = max_sim

                mmr_score = lambda_relevance * relevance - (1.0 - lambda_relevance) * diversity

                if best_mmr is None or mmr_score > best_mmr:
                    best_mmr = mmr_score
                    best_idx = idx

            if best_idx is None:
                break

            mem_type, bucket_idx, mem, _ = flat[best_idx]

            # Add to selected set and track text
            mem_text = mem.get("memory", "").strip()
            selected_global.append(best_idx)
            selected_texts.add(mem_text)

            if mem_type == "text":
                text_selected_by_bucket[bucket_idx].append(best_idx)
            elif mem_type == "preference":
                pref_selected_by_bucket[bucket_idx].append(best_idx)
            remaining.remove(best_idx)

            # Early termination: all buckets are full
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

        # Phase 3: Re-sort by original relevance and fill back to buckets
        for bucket_idx, bucket in enumerate(text_buckets):
            selected_indices = text_selected_by_bucket.get(bucket_idx, [])
            selected_indices = sorted(selected_indices, key=lambda i: flat[i][3], reverse=True)
            bucket["memories"] = [flat[i][2] for i in selected_indices]

        for bucket_idx, bucket in enumerate(pref_buckets):
            selected_indices = pref_selected_by_bucket.get(bucket_idx, [])
            selected_indices = sorted(selected_indices, key=lambda i: flat[i][3], reverse=True)
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

    @staticmethod
    def _extract_embeddings(memories: list[dict[str, Any]]) -> list[list[float]] | None:
        embeddings: list[list[float]] = []
        for mem in memories:
            embedding = mem.get("metadata", {}).get("embedding")
            if not embedding:
                return None
            embeddings.append(embedding)
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
