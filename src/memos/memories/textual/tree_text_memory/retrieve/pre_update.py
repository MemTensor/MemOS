import concurrent.futures
import re

from typing import Any

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_reader.read_multi_modal.utils import detect_lang
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import FastTokenizer


logger = get_logger(__name__)


class PreUpdateRetriever:
    def __init__(self, graph_db, embedder):
        """
        The PreUpdateRetriever is designed for the /add phase .
        It serves to recall potentially duplicate/conflict memories against the new content that's being added.

        Args:
            graph_db: The graph database instance (Neo4j, PolarDB, etc.)
            embedder: The embedder instance for vector search
        """
        self.graph_db = graph_db
        self.embedder = embedder
        # Use existing tokenizer for keyword extraction
        self.tokenizer = FastTokenizer(use_jieba=True, use_stopwords=True)

    def _adjust_perspective(self, text: str, role: str, lang: str) -> str:
        """
        For better search result, we adjust the perspective
        from 1st person to 3rd person based on role and language.
        "I" -> "User" (if role is user)
        "I" -> "Assistant" (if role is assistant)
        """
        if not role:
            return text

        role = role.lower()
        replacements = []

        # Determine replacements based on language and role
        if lang == "zh":
            if role == "user":
                replacements = [("我", "用户")]
            elif role == "assistant":
                replacements = [("我", "助手")]
        else:  # default to en
            if role == "user":
                replacements = [
                    (r"\bI\b", "User"),
                    (r"\bme\b", "User"),
                    (r"\bmy\b", "User's"),
                    (r"\bmine\b", "User's"),
                    (r"\bmyself\b", "User himself"),
                ]
            elif role == "assistant":
                replacements = [
                    (r"\bI\b", "Assistant"),
                    (r"\bme\b", "Assistant"),
                    (r"\bmy\b", "Assistant's"),
                    (r"\bmine\b", "Assistant's"),
                    (r"\bmyself\b", "Assistant himself"),
                ]

        adjusted_text = text
        for pattern, repl in replacements:
            if lang == "zh":
                adjusted_text = adjusted_text.replace(pattern, repl)
            else:
                adjusted_text = re.sub(pattern, repl, adjusted_text, flags=re.IGNORECASE)

        return adjusted_text

    def _preprocess_query(self, item: TextualMemoryItem) -> str:
        """
        Preprocess the query item:
        1. Extract language and role from metadata/sources
        2. Adjust perspective (I -> User/Assistant) based on role/lang
        """
        raw_text = item.memory or ""
        if not raw_text.strip():
            return ""

        # Extract lang/role
        lang = None
        role = None
        sources = item.metadata.sources

        if sources:
            source_list = sources if isinstance(sources, list) else [sources]
            for source in source_list:
                if hasattr(source, "lang") and source.lang:
                    lang = source.lang
                elif isinstance(source, dict) and source.get("lang"):
                    lang = source.get("lang")

                if hasattr(source, "role") and source.role:
                    role = source.role
                elif isinstance(source, dict) and source.get("role"):
                    role = source.get("role")

                if lang and role:
                    break

        if lang is None:
            lang = detect_lang(raw_text)

        # Adjust perspective
        return self._adjust_perspective(raw_text, role, lang)

    def _get_full_memories(
        self, candidate_ids: list[str], user_name: str
    ) -> list[TextualMemoryItem]:
        """
        Retrieve full memories for given candidate ids.
        """
        full_recalled_memories = self.graph_db.get_nodes(candidate_ids, user_name=user_name)
        return [TextualMemoryItem.from_dict(item) for item in full_recalled_memories]

    def vector_search(
        self,
        query_text: str,
        query_embedding: list[float] | None,
        user_name: str,
        top_k: int,
        search_filter: dict[str, Any] | None = None,
        threshold: float = 0.5,
    ) -> list[dict]:
        try:
            # Use pre-computed embedding if available (matches raw/clean query)
            # Otherwise embed the switched query for better semantic match
            q_embed = query_embedding if query_embedding else self.embedder.embed([query_text])[0]

            # Assuming graph_db.search_by_embedding returns list of dicts or items
            results = self.graph_db.search_by_embedding(
                vector=q_embed,
                top_k=top_k,
                status=None,
                threshold=threshold,
                user_name=user_name,
                filter=search_filter,
            )
            return results
        except Exception as e:
            logger.error(f"[PreUpdateRetriever] Vector search failed: {e}")
            return []

    def keyword_search(
        self,
        query_text: str,
        user_name: str,
        top_k: int,
        search_filter: dict[str, Any] | None = None,
    ) -> list[dict]:
        try:
            # 1. Tokenize using existing tokenizer
            keywords = self.tokenizer.tokenize_mixed(query_text)
            if not keywords:
                return []

            results = []

            # 2. Try seach_by_keywords_tfidf (PolarDB specific)
            if hasattr(self.graph_db, "seach_by_keywords_tfidf"):
                try:
                    results = self.graph_db.seach_by_keywords_tfidf(
                        query_words=keywords, user_name=user_name, filter=search_filter
                    )
                except Exception as e:
                    logger.warning(f"[PreUpdateRetriever] seach_by_keywords_tfidf failed: {e}")

            # 3. Fallback to search_by_fulltext
            if not results and hasattr(self.graph_db, "search_by_fulltext"):
                try:
                    results = self.graph_db.search_by_fulltext(
                        query_words=keywords, top_k=top_k, user_name=user_name, filter=search_filter
                    )
                except Exception as e:
                    logger.warning(f"[PreUpdateRetriever] search_by_fulltext failed: {e}")

            return results[:top_k]

        except Exception as e:
            logger.error(f"[PreUpdateRetriever] Keyword search failed: {e}")
            return []

    def retrieve(
        self, item: TextualMemoryItem, user_name: str, top_k: int = 10, sim_threshold: float = 0.5
    ) -> list[TextualMemoryItem]:
        """
        Recall related memories for a TextualMemoryItem using hybrid search (Vector + Keyword).
        Might actually return top_k ~ 2top_k items.
        Designed for low latency.

        Args:
            item: The memory item to find related memories for
            user_name: User identifier for scoping search
            top_k: Max number of results to return
            sim_threshold: minimal similarity threshold for vector search

        Returns:
            List of TextualMemoryItem
        """
        # 1. Preprocess
        switched_query = self._preprocess_query(item)

        # 2. Recall
        futures = []
        common_filter = {
            "status": {"in": ["activated", "resolving"]},
            "memory_type": {"in": ["LongTermMemory", "UserMemory", "WorkingMemory"]},
        }

        with ContextThreadPoolExecutor(max_workers=3, thread_name_prefix="fast_recall") as executor:
            # Task A: Vector Search (Semantic)
            query_embedding = (
                item.metadata.embedding if hasattr(item.metadata, "embedding") else None
            )
            futures.append(
                executor.submit(
                    self.vector_search,
                    switched_query,
                    query_embedding,
                    user_name,
                    top_k,
                    common_filter,
                    sim_threshold,
                )
            )

            # Task B: Keyword Search
            futures.append(
                executor.submit(
                    self.keyword_search, switched_query, user_name, top_k, common_filter
                )
            )

            # 3. Collect Results
            retrieved_ids = set()  # for deduplicating ids
            for future in concurrent.futures.as_completed(futures):
                try:
                    res = future.result()
                    if not res:
                        continue

                    for r in res:
                        retrieved_ids.add(r["id"])

                except Exception as e:
                    logger.error(f"[PreUpdateRetriever] Search future task failed: {e}")

        retrieved_ids = list(retrieved_ids)

        if not retrieved_ids:
            return []

        # 4. Retrieve full memories to from just ids
        # TODO: We should modify the db functions to support returning arbitrary fields, instead of search twice.
        final_memories = self._get_full_memories(retrieved_ids, user_name)

        return final_memories
