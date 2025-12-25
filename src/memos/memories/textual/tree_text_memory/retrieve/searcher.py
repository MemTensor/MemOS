import traceback

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import SearchedTreeNodeTextualMemoryMetadata, TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.bm25_util import EnhancedBM25
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import (
    FastTokenizer,
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
        self.manual_close_internet = manual_close_internet
        self.tokenizer = tokenizer
        self._usage_executor = ContextThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")

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
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        logger.info(
            f"[RECALL] Start query='{query}', top_k={top_k}, mode={mode}, memory_type={memory_type}"
        )
        parsed_goal, query_embedding, context, query = self._parse_task(
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
        plugin=False,
    ):
        deduped = self._deduplicate_results(retrieved_results)
        final_results = self._sort_and_trim(
            deduped, top_k, plugin, search_tool_memory, tool_mem_top_k
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
        )

        logger.info(f"[SEARCH] Done. Total {len(final_results)} results.")
        res_results = ""
        for _num_i, result in enumerate(final_results):
            res_results += "\n" + (
                result.id + "|" + result.metadata.memory_type + "|" + result.memory
            )
        logger.info(f"[SEARCH] Results. {res_results}")
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
                self.graph_store.get_node(n["id"])
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
            query_embedding = self.embedder.embed(list({query, *parsed_goal.memories}))

        return parsed_goal, query_embedding, context, query

    @timed
    def _retrieve_simple(
        self,
        query: str,
        top_k: int,
        search_filter: dict | None = None,
        user_name: str | None = None,
        **kwargs,
    ):
        """Retrieve from by keywords and embedding"""
        query_words = []
        if self.tokenizer:
            query_words = self.tokenizer.tokenize_mixed(query)
        else:
            query_words = query.strip().split()
        query_words = [query, *query_words]
        logger.info(f"[SIMPLESEARCH] Query words: {query_words}")
        query_embeddings = self.embedder.embed(query_words)

        items = self.graph_retriever.retrieve_from_mixed(
            top_k=top_k * 2,
            memory_scope=None,
            query_embedding=query_embeddings,
            search_filter=search_filter,
            user_name=user_name,
            use_fast_graph=self.use_fast_graph,
        )
        logger.info(f"[SIMPLESEARCH] Items count: {len(items)}")
        documents = [getattr(item, "memory", "") for item in items]
        documents_embeddings = self.embedder.embed(documents)
        similarity_matrix = cosine_similarity_matrix(documents_embeddings)
        selected_indices, _ = find_best_unrelated_subgroup(documents, similarity_matrix)
        selected_items = [items[i] for i in selected_indices]
        logger.info(
            f"[SIMPLESEARCH] after unrelated subgroup selection items count: {len(selected_items)}"
        )
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embeddings[0],
            graph_results=selected_items,
            top_k=top_k,
        )

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
    ):
        """Run A/B/C retrieval paths in parallel"""
        tasks = []
        id_filter = {
            "user_id": info.get("user_id", None),
            "session_id": info.get("session_id", None),
        }
        id_filter = {k: v for k, v in id_filter.items() if v is not None}

        with ContextThreadPoolExecutor(max_workers=3) as executor:
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
                    )
                )
            results = []
            for t in tasks:
                results.extend(t.result())

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
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
            graph_results=items,
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

        with ContextThreadPoolExecutor(max_workers=2) as executor:
            if memory_type in ["All", "LongTermMemory"]:
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
            if memory_type in ["All", "UserMemory"]:
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

            # Collect results from all tasks
            for task in tasks:
                results.extend(task.result())

        return self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
            graph_results=results,
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )

    @timed
    def _retrieve_from_memcubes(
        self, query, parsed_goal, query_embedding, top_k, cube_name="memos_cube01"
    ):
        """Retrieve and rerank from LongTermMemory and UserMemory"""
        results = self.graph_retriever.retrieve_from_cube(
            query_embedding=query_embedding,
            top_k=top_k * 2,
            memory_scope="LongTermMemory",
            cube_name=cube_name,
            user_name=cube_name,
        )
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
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
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
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

        with ContextThreadPoolExecutor(max_workers=2) as executor:
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
                rsp = task.result()
                if rsp and rsp[0].metadata.memory_type == "ToolSchemaMemory":
                    results["ToolSchemaMemory"].extend(rsp)
                elif rsp and rsp[0].metadata.memory_type == "ToolTrajectoryMemory":
                    results["ToolTrajectoryMemory"].extend(rsp)

        schema_reranked = self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
            graph_results=results["ToolSchemaMemory"],
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )
        trajectory_reranked = self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
            graph_results=results["ToolTrajectoryMemory"],
            top_k=top_k,
            parsed_goal=parsed_goal,
            search_filter=search_filter,
        )
        return schema_reranked + trajectory_reranked

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
        documents_embeddings = self.embedder.embed(documents)
        similarity_matrix = cosine_similarity_matrix(documents_embeddings)
        selected_indices, _ = find_best_unrelated_subgroup(documents, similarity_matrix)
        selected_items = [items[i] for i in selected_indices]
        logger.info(
            f"[SIMPLESEARCH] after unrelated subgroup selection items count: {len(selected_items)}"
        )
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embeddings[0],
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
        self, results, top_k, plugin=False, search_tool_memory=False, tool_mem_top_k=6
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
        # separate textual results
        results = [
            (item, score)
            for item, score in results
            if item.metadata.memory_type not in ["ToolSchemaMemory", "ToolTrajectoryMemory"]
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
