import concurrent.futures
import json

from datetime import datetime

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import OllamaLLM, OpenAILLM
from memos.memories.textual.item import SearchedTreeNodeTextualMemoryMetadata, TextualMemoryItem

from .internet_retriever_factory import InternetRetrieverFactory
from .reasoner import MemoryReasoner
from .recall import GraphMemoryRetriever
from .reranker import MemoryReranker
from .task_goal_parser import TaskGoalParser


class Searcher:
    def __init__(
        self,
        dispatcher_llm: OpenAILLM | OllamaLLM,
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

        # Step 1: Parse task structure into topic, concept, and fact levels
        context = []
        if mode == "fine":
            query_embedding = self.embedder.embed([query])[0]
            related_node_ids = self.graph_store.search_by_embedding(query_embedding, top_k=top_k)
            related_nodes = [
                self.graph_store.get_node(related_node["id"]) for related_node in related_node_ids
            ]

            context = [related_node["memory"] for related_node in related_nodes]
            context = list(set(context))

        # Step 1a: Parse task structure into topic, concept, and fact levels
        parsed_goal = self.task_goal_parser.parse(query, "\n".join(context))

        if parsed_goal.memories:
            query_embedding = self.embedder.embed(list({query, *parsed_goal.memories}))

        # Step 2a: Working memory retrieval (Path A)
        def retrieve_from_working_memory():
            """
            Direct structure-based retrieval from working memory.
            """
            if memory_type not in ["All", "WorkingMemory"]:
                return []

            working_memory = self.graph_retriever.retrieve(
                query=query, parsed_goal=parsed_goal, top_k=top_k, memory_scope="WorkingMemory"
            )
            # Rerank working_memory results
            ranked_memories = self.reranker.rerank(
                query=query,
                query_embedding=query_embedding[0],
                graph_results=working_memory,
                top_k=top_k,
                parsed_goal=parsed_goal,
            )
            return ranked_memories

        # Step 2b: Parallel long-term and user memory retrieval (Path B)
        def retrieve_ranked_long_term_and_user():
            """
            Retrieve from both long-term and user memory, then rank and merge results.
            """
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

            # Rerank combined results
            ranked_memories = self.reranker.rerank(
                query=query,
                query_embedding=query_embedding[0],
                graph_results=long_term_items + user_items,
                top_k=top_k * 2,
                parsed_goal=parsed_goal,
            )
            return ranked_memories

        # Step 2c: Internet retrieval (Path C)
        def retrieve_from_internet():
            """
            Retrieve information from the internet using Google Custom Search API.
            """
            if not self.internet_retriever:
                return []
            if memory_type not in ["All"]:
                return []
            internet_items = self.internet_retriever.retrieve_from_internet(
                query=query, top_k=top_k, parsed_goal=parsed_goal
            )

            # Convert to the format expected by reranker
            ranked_memories = self.reranker.rerank(
                query=query,
                query_embedding=query_embedding[0],
                graph_results=internet_items,
                top_k=top_k * 2,
                parsed_goal=parsed_goal,
            )
            return ranked_memories

        # Step 3: Parallel execution of all paths
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            future_working = executor.submit(retrieve_from_working_memory)
            future_hybrid = executor.submit(retrieve_ranked_long_term_and_user)
            future_internet = executor.submit(retrieve_from_internet)

            working_results = future_working.result()
            hybrid_results = future_hybrid.result()
            internet_results = future_internet.result()
            searched_res = working_results + hybrid_results + internet_results

        # Deduplicate by item.memory, keep higher score
        deduped_result = {}
        for item, score in searched_res:
            mem_key = item.memory
            if mem_key not in deduped_result or score > deduped_result[mem_key][1]:
                deduped_result[mem_key] = (item, score)

        searched_res = []
        for item, score in sorted(deduped_result.values(), key=lambda pair: pair[1], reverse=True)[
            :top_k
        ]:
            new_meta = SearchedTreeNodeTextualMemoryMetadata(
                **item.metadata.model_dump(), relativity=score
            )
            searched_res.append(
                TextualMemoryItem(id=item.id, memory=item.memory, metadata=new_meta)
            )

        # Step 4: Reasoning over all retrieved and ranked memory
        if mode == "fine":
            searched_res = self.reasoner.reason(
                query=query,
                ranked_memories=searched_res,
                parsed_goal=parsed_goal,
            )

        # Step 5: Update usage history with current timestamp
        now_time = datetime.now().isoformat()
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
        return searched_res
