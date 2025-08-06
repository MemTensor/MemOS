import concurrent.futures
import json

from datetime import datetime

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import SearchedTreeNodeTextualMemoryMetadata, TextualMemoryItem
from memos.utils import timed

from .internet_retriever_factory import InternetRetrieverFactory
from .reasoner import MemoryReasoner
from .recall import GraphMemoryRetriever
from .reranker import MemoryReranker
from .task_goal_parser import TaskGoalParser


logger = get_logger(__name__)


class Searcher:
    def __init__(
        self,
        dispatcher_llm: OpenAILLM | OllamaLLM | AzureLLM,
        graph_store: Neo4jGraphDB,
        embedder: OllamaEmbedder,
        internet_retriever: InternetRetrieverFactory | None = None,
    ):
        self.graph_store = graph_store
        self.embedder = embedder

        self.task_goal_parser = TaskGoalParser(dispatcher_llm)
        self.graph_retriever = GraphMemoryRetriever(self.graph_store, self.embedder)
        self.reranker = MemoryReranker(dispatcher_llm, self.embedder)
        self.reasoner = MemoryReasoner(dispatcher_llm)

        # Create internet retriever from config if provided
        self.internet_retriever = internet_retriever

    @timed
    def search(
        self, query: str, top_k: int, info=None, mode="fast", memory_type="All"
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

        parsed_goal, query_embedding, context, query = self._parse_task(query, info, mode)
        results = self._retrieve_paths(
            query, parsed_goal, query_embedding, info, top_k, mode, memory_type
        )
        deduped = self._deduplicate_results(results)
        final_results = self._sort_and_trim(deduped, top_k)
        self._update_usage_history(final_results, info)

        logger.info(f"[SEARCH] Done. Total {len(final_results)} results.")
        return final_results

    @timed
    def _parse_task(self, query, info, mode, top_k=5):
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
                for n in self.graph_store.search_by_embedding(query_embedding, top_k=top_k)
            ]
            context = list({node["memory"] for node in related_nodes})

            # optional: supplement context with internet knowledge
            if self.internet_retriever:
                extra = self.internet_retriever.retrieve_from_internet(query=query, top_k=3)
                context.extend(item.memory.partition("\nContent: ")[-1] for item in extra)

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
    def _retrieve_paths(self, query, parsed_goal, query_embedding, info, top_k, mode, memory_type):
        """Run A/B/C retrieval paths in parallel"""
        tasks = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            tasks.append(
                executor.submit(
                    self._retrieve_from_working_memory,
                    query,
                    parsed_goal,
                    query_embedding,
                    top_k,
                    memory_type,
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
                )
            )
            if parsed_goal.internet_search:
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

            results = []
            for t in tasks:
                results.extend(t.result())

        logger.info(f"[SEARCH] Total raw results: {len(results)}")
        return results

    # --- Path A
    @timed
    def _retrieve_from_working_memory(
        self, query, parsed_goal, query_embedding, top_k, memory_type
    ):
        """Retrieve and rerank from WorkingMemory"""
        if memory_type not in ["All", "WorkingMemory"]:
            logger.info(f"[PATH-A] '{query}'Skipped (memory_type does not match)")
            return []
        items = self.graph_retriever.retrieve(
            query=query, parsed_goal=parsed_goal, top_k=top_k, memory_scope="WorkingMemory"
        )
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
            graph_results=items,
            top_k=top_k,
            parsed_goal=parsed_goal,
        )

    # --- Path B
    @timed
    def _retrieve_from_long_term_and_user(
        self, query, parsed_goal, query_embedding, top_k, memory_type
    ):
        """Retrieve and rerank from LongTermMemory and UserMemory"""
        results = []
        if memory_type in ["All", "LongTermMemory"]:
            results += self.graph_retriever.retrieve(
                query=query,
                parsed_goal=parsed_goal,
                query_embedding=query_embedding,
                top_k=top_k * 2,
                memory_scope="LongTermMemory",
            )
        if memory_type in ["All", "UserMemory"]:
            results += self.graph_retriever.retrieve(
                query=query,
                parsed_goal=parsed_goal,
                query_embedding=query_embedding,
                top_k=top_k * 2,
                memory_scope="UserMemory",
            )
        return self.reranker.rerank(
            query=query,
            query_embedding=query_embedding[0],
            graph_results=results,
            top_k=top_k * 2,
            parsed_goal=parsed_goal,
        )

    # --- Path C
    @timed
    def _retrieve_from_internet(
        self, query, parsed_goal, query_embedding, top_k, info, mode, memory_type
    ):
        """Retrieve and rerank from Internet source"""
        if not self.internet_retriever or mode == "fast" or not parsed_goal.internet_search:
            logger.info(
                f"[PATH-C] '{query}' Skipped (no retriever, fast mode, or no internet_search flag)"
            )
            return []
        if memory_type not in ["All"]:
            return []
        items = self.internet_retriever.retrieve_from_internet(
            query=query, top_k=top_k, parsed_goal=parsed_goal, info=info
        )
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
            if "relativity" not in meta_data:
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
        info.pop("chat_history", None)
        # `info` should be a serializable dict or string
        usage_record = json.dumps({"time": now_time, "info": info})
        for item in items:
            if (
                hasattr(item, "id")
                and hasattr(item, "metadata")
                and hasattr(item.metadata, "usage")
            ):
                item.metadata.usage.append(usage_record)
                self.graph_store.update_node(item.id, {"usage": item.metadata.usage})
