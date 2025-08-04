import numpy as np

from memos.embedders.factory import OllamaEmbedder
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal


def batch_cosine_similarity(
    query_vec: list[float], candidate_vecs: list[list[float]]
) -> list[float]:
    """
    Compute cosine similarity between a single query vector and multiple candidate vectors using NumPy.

    Args:
        query_vec (list[float]): The query embedding.
        candidate_vecs (list[list[float]]): A list of memory embeddings.

    Returns:
        list[float]: Cosine similarity scores for each candidate.
    """
    query = np.array(query_vec)
    candidates = np.array(candidate_vecs)

    # Normalize query and candidates
    query_norm = np.linalg.norm(query)
    candidates_norm = np.linalg.norm(candidates, axis=1)

    # Compute dot products
    dot_products = np.dot(candidates, query)

    # Avoid division by zero
    eps = 1e-10
    similarities = dot_products / (candidates_norm * query_norm + eps)

    return similarities.tolist()


class MemoryReranker:
    """
    Rank retrieved memory cards by structural priority and contextual similarity.
    """

    def __init__(self, llm: OpenAILLM | OllamaLLM | AzureLLM, embedder: OllamaEmbedder):
        self.llm = llm
        self.embedder = embedder

        # Structural priority weights
        self.level_weights = {
            "topic": 1.0,
            "concept": 1.0,
            "fact": 1.0,
        }

    def rerank(
        self,
        query: str,
        query_embedding: list[float],
        graph_results: list,
        top_k: int,
        parsed_goal: ParsedTaskGoal,
    ) -> list[tuple[TextualMemoryItem, float]]:
        """
        Rerank memory items by relevance to task.

        Args:
            query (str): Original task.
            query_embedding(list[float]): embedding of query
            graph_results (list): Combined retrieval results.
            top_k (int): Number of top results to return.
            parsed_goal (dict): Structured task representation.

        Returns:
            list(tuple): Ranked list of memory items with similarity score.
        """
        # Step 1: Filter out items without embeddings
        items_with_embeddings = [item for item in graph_results if item.metadata.embedding]
        embeddings = [item.metadata.embedding for item in items_with_embeddings]

        if not embeddings:
            return [(item, 0.5) for item in graph_results[:top_k]]

        # Step 2: Compute cosine similarities
        similarity_scores = batch_cosine_similarity(query_embedding, embeddings)

        # Step 3: Apply structural weight boost
        def get_weight(item: TextualMemoryItem) -> float:
            level = item.metadata.background
            return self.level_weights.get(level, 1.0)

        weighted_scores = [
            sim * get_weight(item)
            for sim, item in zip(similarity_scores, items_with_embeddings, strict=False)
        ]

        # Step 4: Sort by weighted score
        sorted_items = sorted(
            zip(items_with_embeddings, weighted_scores, strict=False),
            key=lambda pair: pair[1],
            reverse=True,
        )

        # Step 5: Return top-k items with fallback
        top_items = sorted_items[:top_k]

        if len(top_items) < top_k:
            selected_items = [item for item, _ in top_items]
            remaining = [(item, -1.0) for item in graph_results if item not in selected_items]
            top_items.extend(remaining[: top_k - len(top_items)])

        return top_items  # list of (item, score)
