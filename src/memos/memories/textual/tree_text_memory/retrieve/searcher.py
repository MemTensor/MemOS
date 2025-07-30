import concurrent.futures
import json
import time

from datetime import datetime

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import SearchedTreeNodeTextualMemoryMetadata, TextualMemoryItem

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

    def search(
        self, query: str, top_k: int, info=None, mode: str = "fast", memory_type: str = "All"
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
        overall_start = time.perf_counter()
        logger.info(
            f"[SEARCH] 🚀 Starting search for query='{query}', top_k={top_k}, mode={mode}, memory_type={memory_type}"
        )

        if not info:
            logger.warning(
                "Please input 'info' when use tree.search so that "
                "the database would store the consume history."
            )
            info = {"user_id": "", "session_id": ""}
        else:
            logger.debug(f"[SEARCH] Received info dict: {info}")

        # ===== Step 1: Parse task structure =====
        step_start = time.perf_counter()
        context = []
        if mode == "fine":
            logger.info("[SEARCH] Fine mode enabled, performing initial embedding search...")
            embed_start = time.perf_counter()
            query_embedding = self.embedder.embed([query])[0]
            logger.debug(f"[SEARCH] Query embedding vector length: {len(query_embedding)}")
            logger.info(
                f"[TIMER] Embedding query took {(time.perf_counter() - embed_start) * 1000:.2f} ms"
            )

            search_start = time.perf_counter()
            related_node_ids = self.graph_store.search_by_embedding(query_embedding, top_k=top_k)
            related_nodes = [
                self.graph_store.get_node(related_node["id"]) for related_node in related_node_ids
            ]
            context = [related_node["memory"] for related_node in related_nodes]
            context = list(set(context))
            logger.info(f"[SEARCH] Found {len(related_nodes)} related nodes from graph_store.")
            logger.info(
                f"[TIMER] Graph embedding search took {(time.perf_counter() - search_start) * 1000:.2f} ms"
            )

        parse_start = time.perf_counter()
        parsed_goal = self.task_goal_parser.parse(
            task_description=query,
            context="\n".join(context),
            conversation=info.get("chat_history", []),
            mode=mode,
        )
        logger.info(
            f"[TIMER] TaskGoalParser took {(time.perf_counter() - parse_start) * 1000:.2f} ms"
        )
        logger.info(f"TaskGoalParser result is {parsed_goal}")

        query = parsed_goal.rephrased_query or query
        if parsed_goal.memories:
            embed_extra_start = time.perf_counter()
            query_embedding = self.embedder.embed(list({query, *parsed_goal.memories}))
            logger.info(
                f"[TIMER] Embedding parsed_goal memories took {(time.perf_counter() - embed_extra_start) * 1000:.2f} ms"
            )
        step_end = time.perf_counter()
        logger.info(f"[TIMER] Step 1 (Parsing & Embedding) took {(step_end - step_start):.2f} s")

        # ===== Step 2: Define retrieval paths =====
        def timed(func):
            """Decorator to measure and log time of retrieval steps."""

            def wrapper(*args, **kwargs):
                start = time.perf_counter()
                result = func(*args, **kwargs)
                elapsed = time.perf_counter() - start
                logger.info(f"[TIMER] {func.__name__} took {elapsed:.2f} s")
                return result

            return wrapper

        @timed
        def retrieve_from_working_memory():
            """
            Direct structure-based retrieval from working memory.
            """
            logger.info("[PATH-A] Retrieving from WorkingMemory...")
            if memory_type not in ["All", "WorkingMemory"]:
                logger.info("[PATH-A] Skipped (memory_type does not match)")
                return []
            working_memory = self.graph_retriever.retrieve(
                query=query, parsed_goal=parsed_goal, top_k=top_k, memory_scope="WorkingMemory"
            )

            logger.debug(f"[PATH-A] Retrieved {len(working_memory)} items.")
            # Rerank working_memory results
            rerank_start = time.perf_counter()
            ranked_memories = self.reranker.rerank(
                query=query,
                query_embedding=query_embedding[0],
                graph_results=working_memory,
                top_k=top_k,
                parsed_goal=parsed_goal,
            )
            logger.info(
                f"[TIMER] PATH-A rerank took {(time.perf_counter() - rerank_start) * 1000:.2f} ms"
            )
            for i, (item, score) in enumerate(ranked_memories[:2], start=1):
                logger.info(f"[PATH-A][TOP{i}] score={score:.4f} memory={item.memory[:80]}...")

            return ranked_memories

        @timed
        def retrieve_ranked_long_term_and_user():
            logger.info("[PATH-B] Retrieving from LongTermMemory & UserMemory...")
            long_term_items = (
                self.graph_retriever.retrieve(
                    query=query,
                    query_embedding=query_embedding,
                    parsed_goal=parsed_goal,
                    top_k=top_k * 2,
                    memory_scope="LongTermMemory",
                )
                if memory_type in ["All", "LongTermMemory"]
                else []
            )
            user_items = (
                self.graph_retriever.retrieve(
                    query=query,
                    query_embedding=query_embedding,
                    parsed_goal=parsed_goal,
                    top_k=top_k * 2,
                    memory_scope="UserMemory",
                )
                if memory_type in ["All", "UserMemory"]
                else []
            )
            logger.debug(
                f"[PATH-B] Retrieved {len(long_term_items)} LongTerm + {len(user_items)} UserMemory items."
            )
            rerank_start = time.perf_counter()
            # Rerank combined results
            ranked_memories = self.reranker.rerank(
                query=query,
                query_embedding=query_embedding[0],
                graph_results=long_term_items + user_items,
                top_k=top_k * 2,
                parsed_goal=parsed_goal,
            )
            logger.info(
                f"[TIMER] PATH-B rerank took {(time.perf_counter() - rerank_start) * 1000:.2f} ms"
            )
            for i, (item, score) in enumerate(ranked_memories[:2], start=1):
                logger.info(f"[PATH-B][TOP{i}] score={score:.4f} memory={item.memory[:80]}...")

            return ranked_memories

        @timed
        def retrieve_from_internet():
            """
            Retrieve information from the internet using Google Custom Search API.
            """
            logger.info("[PATH-C] Retrieving from Internet...")
            if not self.internet_retriever or mode == "fast" or not parsed_goal.internet_search:
                logger.info(
                    "[PATH-C] Skipped (no retriever, fast mode, or no internet_search flag)"
                )
                return []
            if memory_type not in ["All"]:
                return []
            internet_items = self.internet_retriever.retrieve_from_internet(
                query=query, top_k=top_k, parsed_goal=parsed_goal, info=info
            )

            logger.debug(f"[PATH-C] Retrieved {len(internet_items)} internet items.")
            rerank_start = time.perf_counter()
            # Convert to the format expected by reranker
            ranked_memories = self.reranker.rerank(
                query=query,
                query_embedding=query_embedding[0],
                graph_results=internet_items,
                top_k=min(top_k, 5),
                parsed_goal=parsed_goal,
            )
            logger.info(
                f"[TIMER] PATH-C rerank took {(time.perf_counter() - rerank_start) * 1000:.2f} ms"
            )
            for i, (item, score) in enumerate(ranked_memories[:2], start=1):
                logger.info(f"[PATH-C][TOP{i}] score={score:.4f} memory={item.memory[:80]}...")

            return ranked_memories

        # ===== Step 3: Run retrieval in parallel =====
        path_start = time.perf_counter()
        if parsed_goal.internet_search:
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
                future_working = executor.submit(retrieve_from_working_memory)
                future_hybrid = executor.submit(retrieve_ranked_long_term_and_user)
                future_internet = executor.submit(retrieve_from_internet)

                working_results = future_working.result()
                hybrid_results = future_hybrid.result()
                internet_results = future_internet.result()
                searched_res = working_results + hybrid_results + internet_results
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                future_working = executor.submit(retrieve_from_working_memory)
                future_hybrid = executor.submit(retrieve_ranked_long_term_and_user)

                working_results = future_working.result()
                hybrid_results = future_hybrid.result()
                searched_res = working_results + hybrid_results
        logger.info(
            f"[TIMER] Step 3 (Retrieval paths) took {(time.perf_counter() - path_start):.2f} s"
        )
        logger.info(f"[SEARCH] Total results before deduplication: {len(searched_res)}")

        # ===== Step 4: Deduplication =====
        dedup_start = time.perf_counter()
        deduped_result = {}
        for item, score in searched_res:
            mem_key = item.memory
            if mem_key not in deduped_result or score > deduped_result[mem_key][1]:
                deduped_result[mem_key] = (item, score)
        logger.info(
            f"[TIMER] Deduplication took {(time.perf_counter() - dedup_start) * 1000:.2f} ms"
        )

        # ===== Step 5: Sorting & trimming =====
        sort_start = time.perf_counter()
        searched_res = []
        for item, score in sorted(deduped_result.values(), key=lambda pair: pair[1], reverse=True)[
            :top_k
        ]:
            meta_data = item.metadata.model_dump()
            if "relativity" not in meta_data:
                meta_data["relativity"] = score
            new_meta = SearchedTreeNodeTextualMemoryMetadata(**meta_data)
            searched_res.append(
                TextualMemoryItem(id=item.id, memory=item.memory, metadata=new_meta)
            )
        logger.info(
            f"[TIMER] Sorting & trimming took {(time.perf_counter() - sort_start) * 1000:.2f} ms"
        )

        # ===== Step 6: Update usage history =====
        usage_start = time.perf_counter()
        now_time = datetime.now().isoformat()
        if "chat_history" in info:
            info.pop("chat_history")
        usage_record = json.dumps(
            {"time": now_time, "info": info}
        )  # `info` should be a serializable dict or string
        for item in searched_res:
            if (
                hasattr(item, "id")
                and hasattr(item, "metadata")
                and hasattr(item.metadata, "usage")
            ):
                item.metadata.usage.append(usage_record)
                self.graph_store.update_node(item.id, {"usage": item.metadata.usage})
        logger.info(
            f"[TIMER] Usage history update took {(time.perf_counter() - usage_start) * 1000:.2f} ms"
        )

        # ===== Finish =====
        logger.info(f"[SEARCH] ✅ Final top_k results: {len(searched_res)}")
        logger.info(f"[SEARCH] 🔚 Total search took {(time.perf_counter() - overall_start):.2f} s")
        return searched_res
