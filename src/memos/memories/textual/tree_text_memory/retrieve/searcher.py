import json
import traceback

from datetime import datetime

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import SearchedTreeNodeTextualMemoryMetadata, TextualMemoryItem
from memos.reranker.base import BaseReranker
from memos.utils import timed

from .internet_retriever_factory import InternetRetrieverFactory
from .reasoner import MemoryReasoner
from .recall import GraphMemoryRetriever
from .task_goal_parser import TaskGoalParser


logger = get_logger(__name__)


class Searcher:
    def __init__(
        self,
        dispatcher_llm: OpenAILLM | OllamaLLM | AzureLLM,
        graph_store: Neo4jGraphDB,
        embedder: OllamaEmbedder,
        reranker: BaseReranker,
        internet_retriever: InternetRetrieverFactory | None = None,
        moscube: bool = False,
    ):
        self.graph_store = graph_store
        self.embedder = embedder

        self.task_goal_parser = TaskGoalParser(dispatcher_llm)
        self.graph_retriever = GraphMemoryRetriever(self.graph_store, self.embedder)
        self.reranker = reranker
        self.reasoner = MemoryReasoner(dispatcher_llm)

        # Create internet retriever from config if provided
        self.internet_retriever = internet_retriever
        self.moscube = moscube

        self._usage_executor = ContextThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")

    @timed
    def search(
        self,
        query: str,
        top_k: int,
        info=None,
        mode="fast",
        memory_type="All",
        search_filter: dict | None = None,
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
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
        logger.info(
            f"[SEARCH] Start query='{query}', top_k={top_k}, mode={mode}, memory_type={memory_type}"
        )
        if not info:
            logger.warning(
                "Please input 'info' when use tree.search so that "
                "the database would store the consume history."
            )
            info = {"user_id": "", "session_id": ""}
        else:
            logger.debug(f"[SEARCH] Received info dict: {info}")

        parsed_goal, query_embedding, context, query = self._parse_task(
            query, info, mode, search_filter=search_filter
        )
        results = self._retrieve_paths(
            query, parsed_goal, query_embedding, info, top_k, mode, memory_type, search_filter
        )
        deduped = self._deduplicate_results(results)
        final_results = self._sort_and_trim(deduped, top_k)
        self._update_usage_history(final_results, info)

        logger.info(f"[SEARCH] Done. Total {len(final_results)} results.")
        res_results = ""
        for _num_i, result in enumerate(final_results):
            res_results += "\n" + (
                result.id + "|" + result.metadata.memory_type + "|" + result.memory
            )
        logger.info(f"[SEARCH] Results. {res_results}")
        return final_results

    @timed
    def _parse_task(self, query, info, mode, top_k=5, search_filter: dict | None = None):
        """Parse user query, do embedding search and create context"""
        context = []
        query_embedding = None

        # fine mode will trigger initial embedding search
        if mode == "fine":
            logger.info("[SEARCH] Fine mode: embedding search")
            query_embedding = self.embedder.embed([query])[0]

            # retrieve related nodes by embedding
            related_nodes = [
                self.graph_store.get_node(n["id"])
                for n in self.graph_store.search_by_embedding(
                    query_embedding, top_k=top_k, search_filter=search_filter
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
        )

        query = parsed_goal.rephrased_query or query
        # if goal has extra memories, embed them too
        if parsed_goal.memories:
            query_embedding = self.embedder.embed(list({query, *parsed_goal.memories}))

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
    ):
        """Run A/B/C retrieval paths in parallel"""
        tasks = []
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
                )
            )
            if self.moscube:
                tasks.append(
                    executor.submit(
                        self._retrieve_from_memcubes,
                        query,
                        parsed_goal,
                        query_embedding,
                        top_k,
                        "memos_cube01",
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
    ):
        """Retrieve and rerank from LongTermMemory and UserMemory"""
        results = []
        tasks = []

        with ContextThreadPoolExecutor(max_workers=2) as executor:
            if memory_type in ["All", "LongTermMemory"]:
                tasks.append(
                    executor.submit(
                        self.graph_retriever.retrieve,
                        query=query,
                        parsed_goal=parsed_goal,
                        query_embedding=query_embedding,
                        top_k=top_k * 2,
                        memory_scope="LongTermMemory",
                        search_filter=search_filter,
                    )
                )
            if memory_type in ["All", "UserMemory"]:
                tasks.append(
                    executor.submit(
                        self.graph_retriever.retrieve,
                        query=query,
                        parsed_goal=parsed_goal,
                        query_embedding=query_embedding,
                        top_k=top_k * 2,
                        memory_scope="UserMemory",
                        search_filter=search_filter,
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
        self, query, parsed_goal, query_embedding, top_k, info, mode, memory_type
    ):
        """Retrieve and rerank from Internet source"""
        if not self.internet_retriever or mode == "fast":
            logger.info(f"[PATH-C] '{query}' Skipped (no retriever, fast mode)")
            return []
        if memory_type not in ["All"]:
            return []
        logger.info(f"[PATH-C] '{query}' Retrieving from internet...")
        items = self.internet_retriever.retrieve_from_internet(
            query=query, top_k=top_k, parsed_goal=parsed_goal, info=info
        )
        logger.info(f"[PATH-C] '{query}' Retrieved from internet {len(items)} items: {items}")
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
            graph_results=items,
            top_k=min(top_k, 5),
            parsed_goal=parsed_goal,
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
    def _sort_and_trim(self, results, top_k):
        """Sort results by score and trim to top_k"""
        sorted_results = sorted(results, key=lambda pair: pair[1], reverse=True)[:top_k]
        final_items = []
        for item, score in sorted_results:
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
    def _update_usage_history(self, items, info):
        """Update usage history in graph DB"""
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
            self._usage_executor.submit(self._update_usage_history_worker, payload, usage_record)

    def _update_usage_history_worker(self, payload, usage_record: str):
        try:
            for item_id, usage_list in payload:
                self.graph_store.update_node(item_id, {"usage": usage_list})
        except Exception:
            logger.exception("[USAGE] update usage failed")
