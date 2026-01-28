"""
Search handler for memory search functionality (Class-based version).

This module provides a class-based implementation of search handlers,
using dependency injection for better modularity and testability.
"""

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

        original_top_k = search_req.top_k
        prev_text_mem_include_embedding: bool | None = None
        prev_graph_retriever_include_embedding: bool | None = None

        if getattr(search_req, "dedup", None) is None:
            search_req.dedup = "mmr"

        try:
            # Expand top_k for deduplication (5x to ensure enough candidates)
            if search_req.dedup in ("sim", "mmr"):
                search_req.top_k = original_top_k * 5

            # Enable embeddings for MMR deduplication
            if search_req.dedup == "mmr":
                text_mem = getattr(self.naive_mem_cube, "text_mem", None)
                if text_mem is not None and hasattr(text_mem, "include_embedding"):
                    prev_text_mem_include_embedding = text_mem.include_embedding
                    text_mem.include_embedding = True

                graph_retriever = getattr(self.searcher, "graph_retriever", None)
                if graph_retriever is not None and hasattr(graph_retriever, "include_embedding"):
                    prev_graph_retriever_include_embedding = graph_retriever.include_embedding
                    graph_retriever.include_embedding = True

            # Search and deduplicate
            cube_view = self._build_cube_view(search_req)
            results = cube_view.search_memories(search_req)

            if search_req.dedup == "sim":
                results = self._dedup_text_memories(results, original_top_k)
                self._strip_embeddings(results)
            elif search_req.dedup == "mmr":
                pref_top_k = getattr(search_req, "pref_top_k", 6)
                results = self._mmr_dedup_text_memories(results, original_top_k, pref_top_k)
                self._strip_embeddings(results)
        finally:
            # Restore original states
            search_req.top_k = original_top_k

            if prev_text_mem_include_embedding is not None:
                text_mem = getattr(self.naive_mem_cube, "text_mem", None)
                if text_mem is not None and hasattr(text_mem, "include_embedding"):
                    text_mem.include_embedding = prev_text_mem_include_embedding

            if prev_graph_retriever_include_embedding is not None:
                graph_retriever = getattr(self.searcher, "graph_retriever", None)
                if graph_retriever is not None and hasattr(graph_retriever, "include_embedding"):
                    graph_retriever.include_embedding = prev_graph_retriever_include_embedding

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
                flat.append(("preference", bucket_idx, mem, float(score) if score is not None else 0.0))

        if len(flat) <= 1:
            return results

        # Get or compute embeddings
        embeddings = self._extract_embeddings([mem for _, _, mem, _ in flat])
        if embeddings is None:
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
        prefill_top_n = min(5, text_top_k, pref_top_k) if pref_buckets else min(5, text_top_k)
        ordered_by_relevance = sorted(
            range(len(flat)), key=lambda idx: flat[idx][3], reverse=True
        )
        for idx in ordered_by_relevance[:len(flat)]:
            if len(selected_global) >= prefill_top_n:
                break
            mem_type, bucket_idx, mem, _ = flat[idx]

            # Skip if exact text already exists in selected set
            mem_text = mem.get("memory", "").strip()
            if mem_text in selected_texts:
                continue

            # Skip if highly similar (85% LCS) to any selected text
            if SearchHandler._is_text_highly_similar(mem_text, selected_texts, threshold=0.85):
                continue

            # Check bucket capacity with correct top_k for each type
            if mem_type == "text":
                if len(text_selected_by_bucket[bucket_idx]) >= text_top_k:
                    continue
                selected_global.append(idx)
                text_selected_by_bucket[bucket_idx].append(idx)
                selected_texts.add(mem_text)
            elif mem_type == "preference":
                if len(pref_selected_by_bucket[bucket_idx]) >= pref_top_k:
                    continue
                selected_global.append(idx)
                pref_selected_by_bucket[bucket_idx].append(idx)
                selected_texts.add(mem_text)

        # Phase 2: MMR selection for remaining slots
        lambda_relevance = 0.8
        similarity_threshold = 0.92
        beta_high_similarity = 12.0  # Penalty multiplier for similarity > 0.92
        remaining = set(range(len(flat))) - set(selected_global)

        while remaining:
            best_idx: int | None = None
            best_mmr: float | None = None

            for idx in remaining:
                mem_type, bucket_idx, mem, _ = flat[idx]

                # Check bucket capacity with correct top_k for each type
                if mem_type == "text":
                    if len(text_selected_by_bucket[bucket_idx]) >= text_top_k:
                        continue
                elif mem_type == "preference":
                    if len(pref_selected_by_bucket[bucket_idx]) >= pref_top_k:
                        continue

                # Check if exact text already exists - if so, skip this candidate entirely
                mem_text = mem.get("memory", "").strip()
                if mem_text in selected_texts:
                    continue  # Skip duplicate text, don't participate in MMR competition

                # Skip if highly similar (95% LCS) to any selected text
                if SearchHandler._is_text_highly_similar(mem_text, selected_texts, threshold=0.95):
                    continue  # Skip highly similar text, don't participate in MMR competition

                relevance = flat[idx][3]
                max_sim = (
                    0.0
                    if not selected_global
                    else max(similarity_matrix[idx][j] for j in selected_global)
                )

                # Progressive penalty for high similarity (> 0.92)
                if max_sim > similarity_threshold:
                    diversity = max_sim + (max_sim - similarity_threshold) * beta_high_similarity
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
    def _lcs_ratio(text1: str, text2: str) -> float:
        """
        计算最长公共子序列（LCS）占较短文本的比例
        使用空间优化的动态规划算法，只保留一行

        Args:
            text1: 第一个文本
            text2: 第二个文本

        Returns:
            LCS长度 / min(len(text1), len(text2))
        """
        if not text1 or not text2:
            return 0.0

        m, n = len(text1), len(text2)
        min_len = min(m, n)

        # 优化：如果长度差异太大（超过20%），不可能达到95%相似
        if abs(m - n) > min_len * 0.2:
            return 0.0

        # 空间优化的DP，只保留一行
        prev = [0] * (n + 1)

        for i in range(1, m + 1):
            curr = [0] * (n + 1)
            for j in range(1, n + 1):
                if text1[i-1] == text2[j-1]:
                    curr[j] = prev[j-1] + 1
                else:
                    curr[j] = max(curr[j-1], prev[j])
            prev = curr

        lcs_len = prev[n]
        return lcs_len / min_len if min_len > 0 else 0.0

    @staticmethod
    def _is_text_highly_similar(candidate: str, selected_texts: set[str], threshold: float = 0.85) -> bool:
        """
        快速检查候选文本是否与已选择的任何文本高度相似（基于LCS）

        优化策略：
        1. 先检查长度差异（超过20%直接跳过）
        2. 计算LCS比例，如果 >= threshold 则认为高度相似

        Args:
            candidate: 候选文本
            selected_texts: 已选择的文本集合
            threshold: 相似度阈值（默认0.85，表示85%相似）

        Returns:
            True if 高度相似，False otherwise
        """
        candidate = candidate.strip()
        if not candidate:
            return False

        for selected in selected_texts:
            selected = selected.strip()
            if not selected:
                continue

            # 快速检查：长度差异超过20%则不可能95%相似
            min_len = min(len(candidate), len(selected))
            if abs(len(candidate) - len(selected)) > min_len * 0.2:
                continue

            # 计算LCS比例
            lcs_ratio = SearchHandler._lcs_ratio(candidate, selected)
            if lcs_ratio >= threshold:
                return True

        return False

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
        for bucket in results.get("text_mem", []):
            for mem in bucket.get("memories", []):
                metadata = mem.get("metadata", {})
                if "embedding" in metadata:
                    metadata["embedding"] = []
        for bucket in results.get("tool_mem", []):
            for mem in bucket.get("memories", []):
                metadata = mem.get("metadata", {})
                if "embedding" in metadata:
                    metadata["embedding"] = []

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

    def _build_cube_view(self, search_req: APISearchRequest) -> MemCubeView:
        cube_ids = self._resolve_cube_ids(search_req)

        if len(cube_ids) == 1:
            cube_id = cube_ids[0]
            return SingleCubeView(
                cube_id=cube_id,
                naive_mem_cube=self.naive_mem_cube,
                mem_reader=self.mem_reader,
                mem_scheduler=self.mem_scheduler,
                logger=self.logger,
                searcher=self.searcher,
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
                    searcher=self.searcher,
                    deepsearch_agent=self.deepsearch_agent,
                )
                for cube_id in cube_ids
            ]
            return CompositeCubeView(cube_views=single_views, logger=self.logger)
