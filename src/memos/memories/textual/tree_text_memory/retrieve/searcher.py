import copy
import importlib
import re
import traceback

from concurrent.futures import as_completed

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger, summarize_textual_memories
from memos.memories.textual.item import SearchedTreeNodeTextualMemoryMetadata, TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.bm25_util import EnhancedBM25
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import (
    FastTokenizer,
    StopwordManager,
    cosine_similarity_matrix,
    detect_lang,
    find_best_unrelated_subgroup,
    parse_json_result,
)
from memos.reranker.base import BaseReranker
from memos.templates.mem_search_prompts import (
    COT_PROMPT,
    COT_PROMPT_ZH,
    SIMPLE_COT_PROMPT,
    SIMPLE_COT_PROMPT_ZH,
)
from memos.utils import timed

from .reasoner import MemoryReasoner
from .recall import GraphMemoryRetriever
from .task_goal_parser import TaskGoalParser


logger = get_logger(__name__)
KEYWORD_EXTRACT_TOP_K = 3
KEYWORD_ALLOW_POS = ("n", "nr", "nrt", "ns", "nt", "nz", "vn", "v", "t", "eng", "m")
# Timeout (seconds) applied to every future.result() inside the four search
# methods that used to open a fresh ContextThreadPoolExecutor per request
# (#1273). A per-future timeout is a safety net: because the executors are now
# shared class-level pools, hung sub-tasks cannot make the total thread count
# grow with QPS, but a hung task can still occupy one worker slot indefinitely.
# The timeout ensures the calling request does not block forever on such tasks.
SEARCH_FUTURE_RESULT_TIMEOUT = 30.0
COT_DICT = {
    "fine": {"en": COT_PROMPT, "zh": COT_PROMPT_ZH},
    "fast": {"en": SIMPLE_COT_PROMPT, "zh": SIMPLE_COT_PROMPT_ZH},
}


class Searcher:
    def __init__(
        self,
        dispatcher_llm: OpenAILLM | OllamaLLM | AzureLLM,
        graph_store: Neo4jGraphDB,
        embedder: OllamaEmbedder,
        reranker: BaseReranker,
        bm25_retriever: EnhancedBM25 | None = None,
        internet_retriever: None = None,
        search_strategy: dict | None = None,
        manual_close_internet: bool = True,
        tokenizer: FastTokenizer | None = None,
        include_embedding: bool = False,
    ):
        self.graph_store = graph_store
        self.embedder = embedder
        self.llm = dispatcher_llm

        self.task_goal_parser = TaskGoalParser(dispatcher_llm)
        self.graph_retriever = GraphMemoryRetriever(
            graph_store, embedder, bm25_retriever, include_embedding=include_embedding
        )
        self.reranker = reranker
        self.reasoner = MemoryReasoner(dispatcher_llm)

        # Create internet retriever from config if provided
        self.internet_retriever = internet_retriever
        self.vec_cot = search_strategy.get("cot", False) if search_strategy else False
        self.use_fast_graph = search_strategy.get("fast_graph", False) if search_strategy else False
        self.use_fulltext = search_strategy.get("fulltext", False) if search_strategy else False
        self.manual_close_internet = manual_close_internet
        self.tokenizer = tokenizer
        self._usage_executor = ContextThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")
        # Shared, class-level executors for search paths. Previously the
        # four methods below opened a fresh ContextThreadPoolExecutor on
        # every request; if any sub-task hung (slow Neo4j, unresponsive
        # embedding API), `with ... as executor` would block in
        # shutdown(wait=True) and leak threads, growing container thread
        # count without bound (#1273). Using class-level pools bounds the
        # total worker thread count for a Searcher instance to
        # 5 + 3 + 2 + 10 = 20 regardless of QPS.
        self._search_paths_executor = ContextThreadPoolExecutor(
            max_workers=5, thread_name_prefix="search-paths"
        )
        self._search_long_term_executor = ContextThreadPoolExecutor(
            max_workers=3, thread_name_prefix="search-long-term"
        )
        self._search_tool_mem_executor = ContextThreadPoolExecutor(
            max_workers=2, thread_name_prefix="search-tool-mem"
        )
        self._search_dedup_executor = ContextThreadPoolExecutor(
            max_workers=10, thread_name_prefix="search-dedup"
        )

    def close(self) -> None:
        """Shut down all shared thread-pool executors owned by this Searcher.

        The five class-level pools created in ``__init__`` (usage tracking +
        the four search pools introduced for #1273) hold non-daemon worker
        threads that would otherwise outlive the instance. Callers that
        create short-lived ``Searcher`` objects should call ``close()`` when
        done, or use the instance as a context manager
        (``with Searcher(...) as searcher: ...``). ``shutdown(wait=False)``
        is used so a hung sub-task cannot block the caller; idempotent.
        """
        for executor in (
            self._usage_executor,
            self._search_paths_executor,
            self._search_long_term_executor,
            self._search_tool_mem_executor,
            self._search_dedup_executor,
        ):
            executor.shutdown(wait=False)

    def __enter__(self) -> "Searcher":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()

    def _maybe_rerank(
        self,
        enabled: bool,
        *,
        query: str,
        graph_results: list[TextualMemoryItem],
        top_k: int,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        if not enabled or self.reranker is None:
            return [(item, 0.0) for item in graph_results[:top_k]]
        return self.reranker.rerank(
            query=query,
            graph_results=graph_results,
            top_k=top_k,
            **kwargs,
        )

    @staticmethod
    def _query_embedding_for_rerank(enabled: bool, query_embedding):
        if not enabled:
            return None
        return query_embedding[0]

    @timed
    def retrieve(
        self,
        query: str,
        top_k: int,
        info=None,
        mode="fast",
        memory_type="All",
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        search_tool_memory: bool = False,
        tool_mem_top_k: int = 6,
        include_skill_memory: bool = False,
        skill_mem_top_k: int = 3,
        include_preference_memory: bool = False,
        pref_mem_top_k: int = 6,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        logger.info(
            f"[RECALL] Start query='{query}', top_k={top_k}, mode={mode}, memory_type={memory_type}, user_name={user_name}"
        )
        rerank = bool(kwargs.get("rerank", True))
        parsed_goal, query_embedding, _context, query = self._parse_task(
            query,
            info,
            mode,
            search_filter=search_filter,
            search_priority=search_priority,
            user_name=user_name,
            **kwargs,
        )
        results = self._retrieve_paths(
            query,
            parsed_goal,
            query_embedding,
            info,
            top_k,
            mode,
            memory_type,
            search_filter,
            search_priority,
            user_name,
            search_tool_memory,
            tool_mem_top_k,
            include_skill_memory,
            skill_mem_top_k,
            include_preference_memory,
            pref_mem_top_k,
            rerank,
        )
        return results

    def post_retrieve(
        self,
        retrieved_results: list[tuple[TextualMemoryItem, float]],
        top_k: int,
        user_name: str | None = None,
        info=None,
        search_tool_memory: bool = False,
        tool_mem_top_k: int = 6,
        include_skill_memory: bool = False,
        skill_mem_top_k: int = 3,
        include_preference_memory: bool = False,
        pref_mem_top_k: int = 6,
        dedup: str | None = None,
        plugin=False,
    ):
        if dedup == "no":
            deduped = retrieved_results
        else:
            deduped = self._deduplicate_results(retrieved_results)
        final_results = self._sort_and_trim(
            deduped,
            top_k,
            plugin,
            search_tool_memory,
            tool_mem_top_k,
            include_skill_memory,
            skill_mem_top_k,
            include_preference_memory,
            pref_mem_top_k,
        )
        self._update_usage_history(final_results, info, user_name)
        return final_results

    @timed
    def search(
        self,
        query: str,
        top_k: int = 10,
        info=None,
        mode="fast",
        memory_type="All",
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        search_tool_memory: bool = False,
        tool_mem_top_k: int = 6,
        include_skill_memory: bool = False,
        skill_mem_top_k: int = 3,
        include_preference_memory: bool = False,
        pref_mem_top_k: int = 6,
        dedup: str | None = None,
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Search for memories based on a query.
        User query -> TaskGoalParser -> GraphMemoryRetriever ->
        MemoryReranker -> MemoryReasoner -> Final output
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
            info (dict): Leave a record of memory consumption.
            mode (str, optional): The mode of the search.
            - 'fast': Uses a faster search process, sacrificing some precision for speed.
            - 'fine': Uses a more detailed search process, invoking large models for higher precision, but slower performance.
            memory_type (str): Type restriction for search.
            ['All', 'WorkingMemory', 'LongTermMemory', 'UserMemory']
            search_filter (dict, optional): Optional metadata filters for search results.
            search_priority (dict, optional): Optional metadata priority for search results.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
        if not info:
            logger.warning(
                "Please input 'info' when use tree.search so that "
                "the database would store the consume history."
            )
            info = {"user_id": "", "session_id": ""}
        else:
            logger.debug(f"[SEARCH] Received info dict: {info}")

        if kwargs.get("plugin", False):
            logger.info(f"[SEARCH] Retrieve from plugin: {query}")
            retrieved_results = self._retrieve_simple(
                query=query, top_k=top_k, search_filter=search_filter, user_name=user_name
            )
        else:
            retrieved_results = self.retrieve(
                query=query,
                top_k=top_k,
                info=info,
                mode=mode,
                memory_type=memory_type,
                search_filter=search_filter,
                search_priority=search_priority,
                user_name=user_name,
                search_tool_memory=search_tool_memory,
                tool_mem_top_k=tool_mem_top_k,
                include_skill_memory=include_skill_memory,
                skill_mem_top_k=skill_mem_top_k,
                include_preference_memory=include_preference_memory,
                pref_mem_top_k=pref_mem_top_k,
                **kwargs,
            )

        full_recall = kwargs.get("full_recall", False)
        if full_recall:
            return retrieved_results

        final_results = self.post_retrieve(
            retrieved_results=retrieved_results,
            top_k=top_k,
            user_name=user_name,
            info=None,
            plugin=kwargs.get("plugin", False),
            search_tool_memory=search_tool_memory,
            tool_mem_top_k=tool_mem_top_k,
            include_skill_memory=include_skill_memory,
            skill_mem_top_k=skill_mem_top_k,
            include_preference_memory=include_preference_memory,
            pref_mem_top_k=pref_mem_top_k,
            dedup=dedup,
        )

        logger.info("[SEARCH] Result summary: %s", summarize_textual_memories(final_results))
        return final_results

    @timed
    def _parse_task(
        self,
        query,
        info,
        mode,
        top_k=5,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        **kwargs,
    ):
        """Parse user query, do embedding search and create context"""
        context = []
        query_embedding = None

        # fine mode will trigger initial embedding search
        if mode == "fine_old":
            logger.info("[SEARCH] Fine mode: embedding search")
            query_embedding = self.embedder.embed([query])[0]

            # retrieve related nodes by embedding
            related_nodes = [
                self.graph_store.get_node(n["id"], user_name=user_name)
                for n in self.graph_store.search_by_embedding(
                    query_embedding,
                    top_k=top_k,
                    status="activated",
                    search_filter=search_priority,
                    filter=search_filter,
                    user_name=user_name,
                )
            ]
            memories = []
            for node in related_nodes:
                try:
                    m = (
                        node.get("memory")
                        if isinstance(node, dict)
                        else (getattr(node, "memory", None))
                    )
                    if isinstance(m, str) and m:
                        memories.append(m)
                except Exception:
                    logger.error(f"[SEARCH] Error during search: {traceback.format_exc()}")
                    continue
            context = list(dict.fromkeys(memories))

            # optional: supplement context with internet knowledge
            """if self.internet_retriever:
                extra = self.internet_retriever.retrieve_from_internet(query=query, top_k=3)
                context.extend(item.memory.partition("\nContent: ")[-1] for item in extra)
            """

        # parse goal using LLM
        parsed_goal = self.task_goal_parser.parse(
            task_description=query,
            context="\n".join(context),
            conversation=info.get("chat_history", []),
            mode=mode,
            use_fast_graph=self.use_fast_graph,
            **kwargs,
        )

        query = parsed_goal.rephrased_query or query
        # if goal has extra memories, embed them too
        if parsed_goal.memories:
            embed_texts = list(dict.fromkeys([query, *parsed_goal.memories]))
            query_embedding = self.embedder.embed(embed_texts)
        return parsed_goal, query_embedding, context, query

    @timed
    def _retrieve_paths(
        self,
        query,
        parsed_goal,
        query_embedding,
        info,
        top_k,
        mode,
        memory_type,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        search_tool_memory: bool = False,
        tool_mem_top_k: int = 6,
        include_skill_memory: bool = False,
        skill_mem_top_k: int = 3,
        include_preference_memory: bool = False,
        pref_mem_top_k: int = 6,
        rerank: bool = True,
    ):
        """Run A/B/C/D/E/F retrieval paths in parallel"""
        tasks = []
        id_filter = {
            "user_id": info.get("user_id", None),
            "session_id": info.get("session_id", None),
        }
        id_filter = {k: v for k, v in id_filter.items() if v is not None}

        # #1273: use the shared class-level executor. Do NOT wrap in `with`
        # — the executor lives for the lifetime of the Searcher, not the
        # request.
        executor = self._search_paths_executor
        tasks.append(
            executor.submit(
                self._retrieve_from_working_memory,
                query,
                parsed_goal,
                query_embedding,
                top_k,
                memory_type,
                search_filter,
                search_priority,
                user_name,
                id_filter,
                rerank=rerank,
            )
        )
        tasks.append(
            executor.submit(
                self._retrieve_from_long_term_and_user,
                query,
                parsed_goal,
                query_embedding,
                top_k,
                memory_type,
                search_filter,
                search_priority,
                user_name,
                id_filter,
                mode=mode,
                rerank=rerank,
            )
        )
        tasks.append(
            executor.submit(
                self._retrieve_from_internet,
                query,
                parsed_goal,
                query_embedding,
                top_k,
                info,
                mode,
                memory_type,
                user_name,
                rerank=rerank,
            )
        )
        if self.use_fulltext:
            tasks.append(
                executor.submit(
                    self._retrieve_from_keyword,
                    query,
                    parsed_goal,
                    query_embedding,
                    top_k,
                    memory_type,
                    search_filter,
                    search_priority,
                    user_name,
                    id_filter,
                    rerank=rerank,
                )
            )
        if search_tool_memory:
            tasks.append(
                executor.submit(
                    self._retrieve_from_tool_memory,
                    query,
                    parsed_goal,
                    query_embedding,
                    tool_mem_top_k,
                    memory_type,
                    search_filter,
                    search_priority,
                    user_name,
                    id_filter,
                    mode=mode,
                    rerank=rerank,
                )
            )
        if include_skill_memory:
            tasks.append(
                executor.submit(
                    self._retrieve_from_skill_memory,
                    query,
                    parsed_goal,
                    query_embedding,
                    skill_mem_top_k,
                    memory_type,
                    search_filter,
                    search_priority,
                    user_name,
                    id_filter,
                    mode=mode,
                    rerank=rerank,
                )
            )
        if include_preference_memory:
            tasks.append(
                executor.submit(
                    self._retrieve_from_preference_memory,
                    query,
                    parsed_goal,
                    query_embedding,
                    pref_mem_top_k,
                    memory_type,
                    search_filter,
                    search_priority,
                    user_name,
                    id_filter,
                    mode=mode,
                    rerank=rerank,
                )
            )
        results = []
        for t in tasks:
            try:
                results.extend(t.result(timeout=SEARCH_FUTURE_RESULT_TIMEOUT))
            except Exception as e:
                logger.warning(
                    "[SEARCH] retrieval sub-task failed or timed out after %.1fs: %s",
                    SEARCH_FUTURE_RESULT_TIMEOUT,
                    e,
                )

        logger.info(f"[SEARCH] Total raw results: {len(results)}")
        return results

    # --- Path A
    @timed
    def _retrieve_from_working_memory(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        memory_type,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        id_filter: dict | None = None,
        rerank: bool = True,
    ):
        """Retrieve and rerank from WorkingMemory"""
        if memory_type not in ["All", "WorkingMemory"]:
            logger.info(f"[PATH-A] '{query}'Skipped (memory_type does not match)")
            return []
        items = self.graph_retriever.retrieve(
            query=query,
            parsed_goal=parsed_goal,
            top_k=top_k,
            memory_scope="WorkingMemory",
            search_filter=search_filter,
            search_priority=search_priority,
            user_name=user_name,
            id_filter=id_filter,
            use_fast_graph=self.use_fast_graph,
        )
        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=items,
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )

    @staticmethod
    def _require_keyword_user_name(user_name: str | None) -> str:
        normalized_user_name = user_name.strip() if isinstance(user_name, str) else ""
        if not normalized_user_name:
            raise ValueError(
                "[PATH-KEYWORD] user_name is required for PolarDB fulltext keyword search"
            )
        return normalized_user_name

    @staticmethod
    def _is_keyword_stopword(term: str) -> bool:
        normalized = term.strip()
        return not normalized or StopwordManager.is_search_stopword(normalized)

    @staticmethod
    def _normalize_keyword_term(term: str) -> str:
        normalized = str(term).strip()
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9]*(?:[._+\-/][A-Za-z0-9]+)*", normalized):
            return normalized.lower()
        return normalized

    @staticmethod
    def _keyword_extract_top_k(query: str, language: str) -> int:
        cleaned_query = query.strip()
        if not cleaned_query:
            return 0
        if len(cleaned_query) <= 12:
            return 1
        if language != "zh":
            token_count = len(re.findall(r"\b[a-zA-Z0-9]+\b", cleaned_query))
            return 2 if token_count <= 8 else KEYWORD_EXTRACT_TOP_K
        if len(cleaned_query) <= 120:
            return 2
        return KEYWORD_EXTRACT_TOP_K

    @classmethod
    def _rank_english_keyword_terms(cls, terms: list[str]) -> list[str]:
        term_stats: dict[str, dict[str, int | str]] = {}
        for index, term in enumerate(terms):
            normalized_term = cls._normalize_keyword_term(term)
            if cls._is_keyword_stopword(normalized_term):
                continue
            key = normalized_term.lower()
            if key not in term_stats:
                term_stats[key] = {"term": normalized_term, "index": index, "count": 0}
            term_stats[key]["count"] = int(term_stats[key]["count"]) + 1

        def score(item: tuple[str, dict[str, int | str]]) -> tuple[float, int]:
            _, data = item
            term = str(data["term"])
            count = int(data["count"])
            term_score = count * 3.0 + min(len(term), 16) * 0.1
            if any(ch.isdigit() for ch in term):
                term_score += 1.0
            if len(term) <= 2:
                term_score -= 0.5
            return (-term_score, int(data["index"]))

        return [str(data["term"]) for _, data in sorted(term_stats.items(), key=score)]

    def _extract_weighted_keyword_terms(self, query: str) -> list[str]:
        language = detect_lang(query)
        keyword_top_k = self._keyword_extract_top_k(query, language)
        if keyword_top_k <= 0:
            return []

        if language == "zh":
            jieba_analyse = importlib.import_module("jieba.analyse")

            weighted_terms = jieba_analyse.extract_tags(
                query,
                topK=keyword_top_k,
                allowPOS=KEYWORD_ALLOW_POS,
            )
        else:
            tokenizer = self.tokenizer or FastTokenizer()
            weighted_terms = self._rank_english_keyword_terms(tokenizer.tokenize_english(query))

        query_words: list[str] = []
        seen_words: set[str] = set()
        for term in weighted_terms:
            normalized_term = self._normalize_keyword_term(term)
            dedupe_key = normalized_term.lower()
            if self._is_keyword_stopword(normalized_term) or dedupe_key in seen_words:
                continue
            seen_words.add(dedupe_key)
            query_words.append(normalized_term)
            if len(query_words) >= keyword_top_k:
                break
        return query_words

    @timed
    def _retrieve_from_keyword(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        memory_type,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        id_filter: dict | None = None,
        rerank: bool = True,
    ) -> list[tuple[TextualMemoryItem, float]]:
        """Keyword/fulltext path that directly calls graph DB fulltext search."""

        if memory_type not in ["All", "LongTermMemory", "UserMemory"]:
            return []
        if not query_embedding:
            return []
        user_name = self._require_keyword_user_name(user_name)

        query_words = self._extract_weighted_keyword_terms(query)
        if not query_words:
            return []
        # Quote weighted terms before `to_tsquery(...)` to avoid parsing operators from user input.
        tsquery_terms = ["'" + w.replace("'", "''") + "'" for w in query_words if w and w.strip()]
        if not tsquery_terms:
            return []
        logger.info(
            "[PATH-KEYWORD] weighted query_words=%s top_k=%s user_name=%s",
            query_words,
            top_k,
            user_name,
        )

        scopes = [memory_type] if memory_type != "All" else ["LongTermMemory", "UserMemory"]

        id_to_score: dict[str, float] = {}
        for scope in scopes:
            try:
                hits = self.graph_store.search_by_fulltext(
                    query_words=tsquery_terms,
                    top_k=top_k,
                    status="activated",
                    scope=scope,
                    search_filter=None,
                    filter=search_filter,
                    user_name=user_name,
                    tsquery_config="jiebaqry",
                )
            except Exception:
                logger.warning(
                    f"[PATH-KEYWORD] search_by_fulltext failed, scope={scope}, user_name={user_name}"
                )
                hits = []
            for h in hits or []:
                hid = str(h.get("id") or "").strip().strip("'\"")
                if not hid:
                    continue
                score = h.get("score", 0.0)
                if hid not in id_to_score or score > id_to_score[hid]:
                    id_to_score[hid] = score
        if not id_to_score:
            return []

        sorted_ids = sorted(id_to_score.keys(), key=lambda x: id_to_score[x], reverse=True)
        sorted_ids = sorted_ids[:top_k]
        node_dicts = (
            self.graph_store.get_nodes(sorted_ids, include_embedding=True, user_name=user_name)
            or []
        )
        id_to_node = {n.get("id"): n for n in node_dicts}
        ordered_nodes = []

        for rid in sorted_ids:
            if rid in id_to_node:
                node = copy.deepcopy(id_to_node[rid])
                meta = node.setdefault("metadata", {})
                meta_target = meta
                if isinstance(meta, dict) and isinstance(meta.get("metadata"), dict):
                    meta_target = meta["metadata"]
                if isinstance(meta_target, dict):
                    meta_target["keyword_score"] = id_to_score[rid]
                ordered_nodes.append(node)

        results = [TextualMemoryItem.from_dict(n) for n in ordered_nodes]
        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=results,
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )

    # --- Path B
    @timed
    def _retrieve_from_long_term_and_user(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        memory_type,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        id_filter: dict | None = None,
        mode: str = "fast",
        rerank: bool = True,
    ):
        """Retrieve and rerank from LongTermMemory and UserMemory"""
        results = []
        tasks = []

        # chain of thinking
        cot_embeddings = []
        if self.vec_cot:
            queries = self._cot_query(query, mode=mode, context=parsed_goal.context)
            if len(queries) > 1:
                cot_embeddings = self.embedder.embed(queries)
            cot_embeddings.extend(query_embedding)
        else:
            cot_embeddings = query_embedding

        # #1273: shared class-level executor; do NOT wrap in `with`.
        executor = self._search_long_term_executor
        if memory_type in ["All", "AllSummaryMemory", "LongTermMemory"]:
            tasks.append(
                executor.submit(
                    self.graph_retriever.retrieve,
                    query=query,
                    parsed_goal=parsed_goal,
                    query_embedding=cot_embeddings,
                    top_k=top_k * 2,
                    memory_scope="LongTermMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    user_name=user_name,
                    id_filter=id_filter,
                    use_fast_graph=self.use_fast_graph,
                )
            )
        if memory_type in ["All", "AllSummaryMemory", "UserMemory"]:
            tasks.append(
                executor.submit(
                    self.graph_retriever.retrieve,
                    query=query,
                    parsed_goal=parsed_goal,
                    query_embedding=cot_embeddings,
                    top_k=top_k * 2,
                    memory_scope="UserMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    user_name=user_name,
                    id_filter=id_filter,
                    use_fast_graph=self.use_fast_graph,
                )
            )
        if memory_type in ["RawFileMemory"]:
            tasks.append(
                executor.submit(
                    self.graph_retriever.retrieve,
                    query=query,
                    parsed_goal=parsed_goal,
                    query_embedding=cot_embeddings,
                    top_k=top_k * 2,
                    memory_scope="RawFileMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    user_name=user_name,
                    id_filter=id_filter,
                    use_fast_graph=self.use_fast_graph,
                )
            )

        # Collect results from all tasks
        for task in tasks:
            try:
                results.extend(task.result(timeout=SEARCH_FUTURE_RESULT_TIMEOUT))
            except Exception as e:
                logger.warning(
                    "[SEARCH] long-term/user sub-task failed or timed out after %.1fs: %s",
                    SEARCH_FUTURE_RESULT_TIMEOUT,
                    e,
                )
        results = self._deduplicate_rawfile_results(results, user_name=user_name)
        results = self._filter_intermediate_content(results)

        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=results,
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )

    @timed
    def _retrieve_from_memcubes(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        cube_name="memos_cube01",
        rerank: bool = True,
    ):
        """Retrieve and rerank from LongTermMemory and UserMemory"""
        results = self.graph_retriever.retrieve_from_cube(
            query_embedding=query_embedding,
            top_k=top_k * 2,
            memory_scope="LongTermMemory",
            cube_name=cube_name,
            user_name=cube_name,
        )
        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=results,
            top_k=top_k,
            parsed_goal=parsed_goal,
        )

    # --- Path C
    @timed
    def _retrieve_from_internet(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        info,
        mode,
        memory_type,
        user_id: str | None = None,
        rerank: bool = True,
    ):
        """Retrieve and rerank from Internet source"""
        if not self.internet_retriever:
            logger.info(f"[PATH-C] '{query}' Skipped (no retriever)")
            return []
        if self.manual_close_internet and not parsed_goal.internet_search:
            logger.info(f"[PATH-C] '{query}' Skipped (no retriever, fast mode)")
            return []
        if memory_type not in ["All", "OuterMemory"]:
            logger.info(f"[PATH-C] '{query}' Skipped (memory_type does not match)")
            return []
        logger.info(f"[PATH-C] '{query}' Retrieving from internet...")
        items = self.internet_retriever.retrieve_from_internet(
            query=query, top_k=2 * top_k, parsed_goal=parsed_goal, info=info, mode=mode
        )
        logger.info(f"[PATH-C] '{query}' Retrieved from internet {len(items)} items: {items}")
        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=items,
            top_k=top_k,
            parsed_goal=parsed_goal,
        )

    # --- Path D
    @timed
    def _retrieve_from_tool_memory(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        memory_type,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        id_filter: dict | None = None,
        mode: str = "fast",
        rerank: bool = True,
    ):
        """Retrieve and rerank from ToolMemory"""
        results = {
            "ToolSchemaMemory": [],
            "ToolTrajectoryMemory": [],
        }
        tasks = []

        # chain of thinking
        cot_embeddings = []
        if self.vec_cot:
            queries = self._cot_query(query, mode=mode, context=parsed_goal.context)
            if len(queries) > 1:
                cot_embeddings = self.embedder.embed(queries)
            cot_embeddings.extend(query_embedding)
        else:
            cot_embeddings = query_embedding

        # #1273: shared class-level executor; do NOT wrap in `with`.
        executor = self._search_tool_mem_executor
        if memory_type in ["All", "ToolSchemaMemory"]:
            tasks.append(
                executor.submit(
                    self.graph_retriever.retrieve,
                    query=query,
                    parsed_goal=parsed_goal,
                    query_embedding=cot_embeddings,
                    top_k=top_k * 2,
                    memory_scope="ToolSchemaMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    user_name=user_name,
                    id_filter=id_filter,
                    use_fast_graph=self.use_fast_graph,
                )
            )
        if memory_type in ["All", "ToolTrajectoryMemory"]:
            tasks.append(
                executor.submit(
                    self.graph_retriever.retrieve,
                    query=query,
                    parsed_goal=parsed_goal,
                    query_embedding=cot_embeddings,
                    top_k=top_k * 2,
                    memory_scope="ToolTrajectoryMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    user_name=user_name,
                    id_filter=id_filter,
                    use_fast_graph=self.use_fast_graph,
                )
            )

        # Collect results from all tasks
        for task in tasks:
            try:
                rsp = task.result(timeout=SEARCH_FUTURE_RESULT_TIMEOUT)
            except Exception as e:
                logger.warning(
                    "[SEARCH] tool-memory sub-task failed or timed out after %.1fs: %s",
                    SEARCH_FUTURE_RESULT_TIMEOUT,
                    e,
                )
                continue
            if rsp and rsp[0].metadata.memory_type == "ToolSchemaMemory":
                results["ToolSchemaMemory"].extend(rsp)
            elif rsp and rsp[0].metadata.memory_type == "ToolTrajectoryMemory":
                results["ToolTrajectoryMemory"].extend(rsp)

        schema_reranked = self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=results["ToolSchemaMemory"],
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )
        trajectory_reranked = self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=results["ToolTrajectoryMemory"],
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )
        return schema_reranked + trajectory_reranked

    # --- Path E
    @timed
    def _retrieve_from_skill_memory(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        memory_type,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        id_filter: dict | None = None,
        mode: str = "fast",
        rerank: bool = True,
    ):
        """Retrieve and rerank from SkillMemory"""

        if memory_type not in ["All", "SkillMemory"]:
            logger.info(f"[PATH-E] '{query}' Skipped (memory_type does not match)")
            return []

        # chain of thinking
        cot_embeddings = []
        if self.vec_cot:
            queries = self._cot_query(query, mode=mode, context=parsed_goal.context)
            if len(queries) > 1:
                cot_embeddings = self.embedder.embed(queries)
            cot_embeddings.extend(query_embedding)
        else:
            cot_embeddings = query_embedding

        items = self.graph_retriever.retrieve(
            query=query,
            parsed_goal=parsed_goal,
            query_embedding=cot_embeddings,
            top_k=top_k * 2,
            memory_scope="SkillMemory",
            search_filter=search_filter,
            search_priority=search_priority,
            user_name=user_name,
            id_filter=id_filter,
            use_fast_graph=self.use_fast_graph,
        )

        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=items,
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )

    @timed
    def _retrieve_from_preference_memory(
        self,
        query,
        parsed_goal,
        query_embedding,
        top_k,
        memory_type,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        user_name: str | None = None,
        id_filter: dict | None = None,
        mode: str = "fast",
        rerank: bool = True,
    ):
        """Retrieve and rerank from PreferenceMemory"""
        if memory_type not in ["All", "PreferenceMemory"]:
            logger.info(f"[PATH-F] '{query}' Skipped (memory_type does not match)")
            return []

        # chain of thinking
        cot_embeddings = []
        if self.vec_cot:
            queries = self._cot_query(query, mode=mode, context=parsed_goal.context)
            if len(queries) > 1:
                cot_embeddings = self.embedder.embed(queries)
            cot_embeddings.extend(query_embedding)
        else:
            cot_embeddings = query_embedding

        items = self.graph_retriever.retrieve(
            query=query,
            parsed_goal=parsed_goal,
            query_embedding=cot_embeddings,
            top_k=top_k * 2,
            memory_scope="PreferenceMemory",
            search_filter=search_filter,
            search_priority=search_priority,
            user_name=user_name,
            id_filter=id_filter,
            use_fast_graph=self.use_fast_graph,
        )

        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embedding),
            graph_results=items,
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )

    @timed
    def _retrieve_simple(
        self,
        query: str,
        top_k: int,
        search_filter: dict | None = None,
        user_name: str | None = None,
        **kwargs,
    ):
        """
        Retrieve from by keywords and embedding, this func is hotfix for sources=plugin mode
        will merge with fulltext retrieval in the future
        """
        query_words = []
        if self.tokenizer:
            query_words = self.tokenizer.tokenize_mixed(query)
        else:
            query_words = query.strip().split()
        query_words = list(set(query_words))[: top_k * 3]
        query_words = [query, *query_words]
        logger.info(f"[SIMPLESEARCH] Query words: {query_words}")
        query_embeddings = self.embedder.embed(query_words)

        items = self.graph_retriever.retrieve_from_mixed(
            top_k=top_k * 2,
            memory_scope=None,
            query_embedding=query_embeddings,
            search_filter=search_filter,
            user_name=user_name,
        )
        logger.info(f"[SIMPLESEARCH] Items count: {len(items)}")
        documents = [getattr(item, "memory", "") for item in items]
        if not documents:
            return []
        documents_embeddings = self.embedder.embed(documents)
        if not documents_embeddings:
            logger.info("[SIMPLESEARCH] Documents embeddings is empty")
            return []
        similarity_matrix = cosine_similarity_matrix(documents_embeddings)
        selected_indices, _ = find_best_unrelated_subgroup(documents, similarity_matrix)
        selected_items = [items[i] for i in selected_indices]
        logger.info(
            f"[SIMPLESEARCH] after unrelated subgroup selection items count: {len(selected_items)}"
        )
        rerank = bool(kwargs.get("rerank", True))
        return self._maybe_rerank(
            rerank,
            query=query,
            query_embedding=self._query_embedding_for_rerank(rerank, query_embeddings),
            graph_results=selected_items,
            top_k=top_k,
        )

    @timed
    def _deduplicate_results(self, results):
        """Deduplicate results by memory text"""
        deduped = {}
        for item, score in results:
            if item.memory not in deduped or score > deduped[item.memory][1]:
                deduped[item.memory] = (item, score)
        return list(deduped.values())

    @timed
    def _sort_and_trim(
        self,
        results,
        top_k,
        plugin=False,
        search_tool_memory=False,
        tool_mem_top_k=6,
        include_skill_memory=False,
        skill_mem_top_k=3,
        include_preference_memory=False,
        pref_mem_top_k=6,
    ):
        """Sort results by score and trim to top_k"""
        final_items = []
        if search_tool_memory:
            tool_schema_results = [
                (item, score)
                for item, score in results
                if item.metadata.memory_type == "ToolSchemaMemory"
            ]
            sorted_tool_schema_results = sorted(
                tool_schema_results, key=lambda pair: pair[1], reverse=True
            )[:tool_mem_top_k]
            for item, score in sorted_tool_schema_results:
                if plugin and round(score, 2) == 0.00:
                    continue
                meta_data = item.metadata.model_dump()
                meta_data["relativity"] = score
                final_items.append(
                    TextualMemoryItem(
                        id=item.id,
                        memory=item.memory,
                        metadata=SearchedTreeNodeTextualMemoryMetadata(**meta_data),
                    )
                )
            tool_trajectory_results = [
                (item, score)
                for item, score in results
                if item.metadata.memory_type == "ToolTrajectoryMemory"
            ]
            sorted_tool_trajectory_results = sorted(
                tool_trajectory_results, key=lambda pair: pair[1], reverse=True
            )[:tool_mem_top_k]
            for item, score in sorted_tool_trajectory_results:
                if plugin and round(score, 2) == 0.00:
                    continue
                meta_data = item.metadata.model_dump()
                meta_data["relativity"] = score
                final_items.append(
                    TextualMemoryItem(
                        id=item.id,
                        memory=item.memory,
                        metadata=SearchedTreeNodeTextualMemoryMetadata(**meta_data),
                    )
                )

        if include_skill_memory:
            skill_results = [
                (item, score)
                for item, score in results
                if item.metadata.memory_type == "SkillMemory"
            ]
            sorted_skill_results = sorted(skill_results, key=lambda pair: pair[1], reverse=True)[
                :skill_mem_top_k
            ]
            for item, score in sorted_skill_results:
                if plugin and round(score, 2) == 0.00:
                    continue
                meta_data = item.metadata.model_dump()
                meta_data["relativity"] = score
                final_items.append(
                    TextualMemoryItem(
                        id=item.id,
                        memory=item.memory,
                        metadata=SearchedTreeNodeTextualMemoryMetadata(**meta_data),
                    )
                )

        if include_preference_memory:
            pref_results = [
                (item, score)
                for item, score in results
                if item.metadata.memory_type == "PreferenceMemory"
            ]
            sorted_pref_results = sorted(pref_results, key=lambda pair: pair[1], reverse=True)[
                :pref_mem_top_k
            ]
            for item, score in sorted_pref_results:
                if plugin and round(score, 2) == 0.00:
                    continue
                meta_data = item.metadata.model_dump()
                meta_data["relativity"] = score
                final_items.append(
                    TextualMemoryItem(
                        id=item.id,
                        memory=item.memory,
                        metadata=SearchedTreeNodeTextualMemoryMetadata(**meta_data),
                    )
                )

        # separate textual results
        results = [
            (item, score)
            for item, score in results
            if item.metadata.memory_type
            in ["WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory", "RawFileMemory"]
        ]

        sorted_results = sorted(results, key=lambda pair: pair[1], reverse=True)[:top_k]

        for item, score in sorted_results:
            if plugin and round(score, 2) == 0.00:
                continue
            meta_data = item.metadata.model_dump()
            meta_data["relativity"] = score
            final_items.append(
                TextualMemoryItem(
                    id=item.id,
                    memory=item.memory,
                    metadata=SearchedTreeNodeTextualMemoryMetadata(**meta_data),
                )
            )
        return final_items

    @timed
    def _deduplicate_rawfile_results(self, results, user_name: str | None = None):
        """
        Deduplicate rawfile related memories by edge
        """
        if not results:
            return results

        summary_ids_to_remove = set()
        rawfile_items = [item for item in results if item.metadata.memory_type == "RawFileMemory"]
        if not rawfile_items:
            return results

        # #1273: shared class-level executor; do NOT wrap in `with`. The
        # pool is sized once (max_workers=10) instead of `min(len, 10)` per
        # request to avoid rebuilding the pool.
        executor = self._search_dedup_executor
        futures = [
            executor.submit(
                self.graph_store.get_edges,
                rawfile_item.id,
                type="SUMMARY",
                direction="OUTGOING",
                user_name=user_name,
            )
            for rawfile_item in rawfile_items
        ]
        try:
            for future in as_completed(futures, timeout=SEARCH_FUTURE_RESULT_TIMEOUT):
                try:
                    # No inner timeout: a future yielded by as_completed() is
                    # already done, so result() returns immediately. Passing a
                    # second timeout here would be redundant and misleading.
                    edges = future.result()
                    for edge in edges:
                        summary_target_id = edge.get("to")
                        if summary_target_id:
                            summary_ids_to_remove.add(summary_target_id)
                            logger.debug(
                                f"[DEDUP] Marking summary node {summary_target_id} for removal (pointed by RawFileMemory)"
                            )
                except Exception as e:
                    logger.warning(f"[DEDUP] Failed to get summary target ids: {e}")
        except Exception as e:
            # as_completed(...) itself timed out — some futures never
            # finished within SEARCH_FUTURE_RESULT_TIMEOUT. Continue with
            # whatever ids we already collected.
            logger.warning(
                "[DEDUP] Timed out waiting for edge lookups after %.1fs: %s",
                SEARCH_FUTURE_RESULT_TIMEOUT,
                e,
            )

        filtered_results = []
        for item in results:
            if item.id in summary_ids_to_remove:
                logger.debug(
                    f"[DEDUP] Removing summary node {item.id} because it is pointed by RawFileMemory"
                )
                continue
            filtered_results.append(item)

        return filtered_results

    def _filter_intermediate_content(self, results):
        """Filter intermediate content"""
        filtered_results = []
        for item in results:
            if (
                "File URL:" not in item.memory
                and "File ID:" not in item.memory
                and "Filename:" not in item.memory
            ):
                filtered_results.append(item)
        return filtered_results

    @timed
    def _update_usage_history(self, items, info, user_name: str | None = None):
        """Update usage history in graph DB
        now_time = datetime.now().isoformat()
        info_copy = dict(info or {})
        info_copy.pop("chat_history", None)
        usage_record = json.dumps({"time": now_time, "info": info_copy})
        payload = []
        for it in items:
            try:
                item_id = getattr(it, "id", None)
                md = getattr(it, "metadata", None)
                if md is None:
                    continue
                if not hasattr(md, "usage") or md.usage is None:
                    md.usage = []
                md.usage.append(usage_record)
                if item_id:
                    payload.append((item_id, list(md.usage)))
            except Exception:
                logger.exception("[USAGE] snapshot item failed")

        if payload:
            self._usage_executor.submit(
                self._update_usage_history_worker, payload, usage_record, user_name
            )
        """

    def _update_usage_history_worker(
        self, payload, usage_record: str, user_name: str | None = None
    ):
        try:
            for item_id, usage_list in payload:
                self.graph_store.update_node(item_id, {"usage": usage_list}, user_name=user_name)
        except Exception:
            logger.exception("[USAGE] update usage failed")

    def _cot_query(
        self,
        query,
        mode="fast",
        split_num: int = 3,
        context: list[str] | None = None,
    ) -> list[str]:
        """Generate chain-of-thought queries"""

        lang = detect_lang(query)
        if mode == "fine" and context:
            template = COT_DICT["fine"][lang]
            prompt = (
                template.replace("${original_query}", query)
                .replace("${split_num_threshold}", str(split_num))
                .replace("${context}", "\n".join(context))
            )
        else:
            template = COT_DICT["fast"][lang]
            prompt = template.replace("${original_query}", query).replace(
                "${split_num_threshold}", str(split_num)
            )

        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages, temperature=0, top_p=1)
            response_json = parse_json_result(response_text)
            assert "is_complex" in response_json
            if not response_json["is_complex"]:
                return [query]
            else:
                assert "sub_questions" in response_json
                logger.info("Query: {} COT: {}".format(query, response_json["sub_questions"]))
                return response_json["sub_questions"][:split_num]
        except Exception as e:
            logger.error(f"[LLM] Exception during chat generation: {e}")
            return [query]
