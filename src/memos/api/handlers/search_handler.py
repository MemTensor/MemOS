"""
Search handler for memory search functionality (Class-based version).

This module provides a class-based implementation of search handlers,
using dependency injection for better modularity and testability.
"""

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

        original_top_k = search_req.top_k
        adjusted_top_k = False

        prev_text_mem_include_embedding: bool | None = None
        prev_graph_retriever_include_embedding: bool | None = None

        search_req.dedup = "mmr"

        # if getattr(search_req, "dedup", None) is None:
        #     search_req.dedup = "mmr"

        try:
            if search_req.dedup == "sim":
                search_req.top_k = original_top_k * 5
                adjusted_top_k = True
            elif search_req.dedup == "mmr":
                search_req.top_k = original_top_k * 5
                adjusted_top_k = True

            if search_req.dedup == "mmr":
                text_mem = getattr(self.naive_mem_cube, "text_mem", None)
                if text_mem is not None and hasattr(text_mem, "include_embedding"):
                    prev_text_mem_include_embedding = text_mem.include_embedding
                    text_mem.include_embedding = True

                graph_retriever = getattr(self.searcher, "graph_retriever", None)
                if graph_retriever is not None and hasattr(graph_retriever, "include_embedding"):
                    prev_graph_retriever_include_embedding = graph_retriever.include_embedding
                    graph_retriever.include_embedding = True

            cube_view = self._build_cube_view(search_req)
            results = cube_view.search_memories(search_req)

            if search_req.dedup == "sim":
                results = self._dedup_text_memories(results, original_top_k)
                self._strip_embeddings(results)
            elif search_req.dedup == "mmr":
                results = self._mmr_dedup_text_memories(results, original_top_k)
                self._strip_embeddings(results)
        finally:
            if adjusted_top_k:
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
        self, results: dict[str, Any], target_top_k: int
    ) -> dict[str, Any]:
        buckets = results.get("text_mem", [])
        if not buckets:
            return results

        flat: list[tuple[int, dict[str, Any], float]] = []
        for bucket_idx, bucket in enumerate(buckets):
            for mem in bucket.get("memories", []):
                score = mem.get("metadata", {}).get("relativity", 0.0)
                flat.append((bucket_idx, mem, float(score) if score is not None else 0.0))

        if len(flat) <= 1:
            return results

        embeddings = self._extract_embeddings([mem for _, mem, _ in flat])
        if embeddings is None:
            documents = [mem.get("memory", "") for _, mem, _ in flat]
            embeddings = self.searcher.embedder.embed(documents)

        similarity_matrix = self._cosine_similarity_matrix_local(embeddings)

        indices_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(buckets))}
        for flat_index, (bucket_idx, _, _) in enumerate(flat):
            indices_by_bucket[bucket_idx].append(flat_index)

        selected_global: list[int] = []
        selected_by_bucket: dict[int, list[int]] = {i: [] for i in range(len(buckets))}

        prefill_top_n = min(5, target_top_k)
        if prefill_top_n > 0:
            ordered_by_relevance = sorted(
                range(len(flat)), key=lambda idx: flat[idx][2], reverse=True
            )
            for idx in ordered_by_relevance:
                if len(selected_global) >= prefill_top_n:
                    break
                bucket_idx = flat[idx][0]
                if len(selected_by_bucket[bucket_idx]) >= target_top_k:
                    continue
                selected_global.append(idx)
                selected_by_bucket[bucket_idx].append(idx)

        lambda_relevance = 0.8
        alpha_tag = 0
        beta_high_similarity = 5.0  # Penalty multiplier for similarity > 0.92
        similarity_threshold = 0.92
        remaining = set(range(len(flat))) - set(selected_global)
        while remaining:
            best_idx: int | None = None
            best_mmr: float | None = None

            for idx in remaining:
                bucket_idx = flat[idx][0]
                if len(selected_by_bucket[bucket_idx]) >= target_top_k:
                    continue

                relevance = flat[idx][2]
                max_sim = (
                    0.0
                    if not selected_global
                    else max(similarity_matrix[idx][j] for j in selected_global)
                )

                # Apply progressive penalty for high similarity (> 0.92)
                if max_sim > similarity_threshold:
                    diversity = max_sim + (max_sim - similarity_threshold) * beta_high_similarity
                else:
                    diversity = max_sim
                tag_penalty = 0.0
                if selected_global:
                    current_tags = set(flat[idx][1].get("metadata", {}).get("tags", []) or [])
                    if current_tags:
                        max_jaccard = 0.0
                        for j in selected_global:
                            other_tags = set(flat[j][1].get("metadata", {}).get("tags", []) or [])
                            if not other_tags:
                                continue
                            inter = current_tags.intersection(other_tags)
                            if not inter:
                                continue
                            union = current_tags.union(other_tags)
                            jaccard = float(len(inter)) / float(len(union)) if union else 0.0
                            if jaccard > max_jaccard:
                                max_jaccard = jaccard
                        tag_penalty = max_jaccard

                mmr_score = (
                    lambda_relevance * relevance
                    - (1.0 - lambda_relevance) * diversity
                    - alpha_tag * tag_penalty
                )

                if best_mmr is None or mmr_score > best_mmr:
                    best_mmr = mmr_score
                    best_idx = idx

            if best_idx is None:
                break

            selected_global.append(best_idx)
            selected_by_bucket[flat[best_idx][0]].append(best_idx)
            remaining.remove(best_idx)

            all_full = True
            for bucket_idx, bucket_indices in indices_by_bucket.items():
                if len(selected_by_bucket[bucket_idx]) < min(target_top_k, len(bucket_indices)):
                    all_full = False
                    break
            if all_full:
                break

        for bucket_idx, bucket in enumerate(buckets):
            selected_indices = selected_by_bucket.get(bucket_idx, [])
            # Re-sort by original relevance score (descending) for better generation quality
            selected_indices = sorted(selected_indices, key=lambda i: flat[i][2], reverse=True)
            bucket["memories"] = [flat[i][1] for i in selected_indices]

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

    @staticmethod
    def _cosine_similarity_matrix_local(embeddings: list[list[float]]) -> list[list[float]]:
        if not embeddings:
            return []

        normalized: list[list[float]] = []
        for vec in embeddings:
            norm_sq = 0.0
            for x in vec:
                xf = float(x)
                norm_sq += xf * xf
            denom = math.sqrt(norm_sq) if norm_sq > 0.0 else 1.0
            normalized.append([float(x) / denom for x in vec])

        n = len(normalized)
        sim: list[list[float]] = [[0.0] * n for _ in range(n)]
        for i in range(n):
            sim[i][i] = 1.0
            vi = normalized[i]
            for j in range(i + 1, n):
                vj = normalized[j]
                dot = 0.0
                for a, b in zip(vi, vj, strict=False):
                    dot += a * b
                sim[i][j] = dot
                sim[j][i] = dot
        return sim

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
