import json
import time

from typing import TYPE_CHECKING

from memos.log import get_logger

from .client_manager import EvalModuleWithClientManager
from .prompts import (
    CONTEXT_ANSWERABILITY_PROMPT,
    SEARCH_PROMPT_MEM0,
    SEARCH_PROMPT_MEM0_GRAPH,
    SEARCH_PROMPT_MEMOS,
    SEARCH_PROMPT_ZEP,
)
from .utils import filter_memory_data


if TYPE_CHECKING:
    from memos.mem_os.main import MOS
logger = get_logger(__name__)


class LocomoEvalModelModules(EvalModuleWithClientManager):
    """
    Contains search methods for different memory frameworks.
    """

    def __init__(self, args):
        super().__init__(args=args)
        self.pre_context_cache = {}

    def analyze_context_answerability(self, context, query, oai_client):
        """
        Analyze whether the given context can answer the query.

        Args:
            context: The context string to analyze
            query: The query string
            oai_client: OpenAI client for LLM analysis

        Returns:
            bool: True if context can answer the query, False otherwise
        """
        try:
            prompt = CONTEXT_ANSWERABILITY_PROMPT.format(context=context, question=query)

            response = oai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=10,
            )

            answer = response.choices[0].message.content.strip().upper()
            return answer == "YES"
        except Exception as e:
            logger.error(f"Error analyzing context answerability: {e}")
            return False

    def mem0_search(self, client, query, speaker_a_user_id, speaker_b_user_id, top_k=20):
        """
        Search memories using the mem0 framework.

        Args:
            client: mem0 client instance
            query: Search query string
            speaker_a_user_id: User ID for first speaker
            speaker_b_user_id: User ID for second speaker
            top_k: Number of results to retrieve

        Returns:
            Tuple containing formatted context and search duration in milliseconds
        """
        start = time.time()
        search_speaker_a_results = client.search(
            query=query,
            top_k=top_k,
            user_id=speaker_a_user_id,
            output_format="v1.1",
            version="v2",
            filters={"AND": [{"user_id": f"{speaker_a_user_id}"}, {"run_id": "*"}]},
        )
        search_speaker_b_results = client.search(
            query=query,
            top_k=top_k,
            user_id=speaker_b_user_id,
            output_format="v1.1",
            version="v2",
            filters={"AND": [{"user_id": f"{speaker_b_user_id}"}, {"run_id": "*"}]},
        )

        # Format speaker A memories
        search_speaker_a_memory = [
            {
                "memory": memory["memory"],
                "timestamp": memory["created_at"],
                "score": round(memory["score"], 2),
            }
            for memory in search_speaker_a_results["results"]
        ]

        search_speaker_a_memory = [
            [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_a_memory]
        ]

        # Format speaker B memories
        search_speaker_b_memory = [
            {
                "memory": memory["memory"],
                "timestamp": memory["created_at"],
                "score": round(memory["score"], 2),
            }
            for memory in search_speaker_b_results["results"]
        ]

        search_speaker_b_memory = [
            [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_b_memory]
        ]

        # Create context using template
        context = SEARCH_PROMPT_MEM0.format(
            speaker_1_user_id=speaker_a_user_id.split("_")[0],
            speaker_1_memories=json.dumps(search_speaker_a_memory, indent=4),
            speaker_2_user_id=speaker_b_user_id.split("_")[0],
            speaker_2_memories=json.dumps(search_speaker_b_memory, indent=4),
        )

        duration_ms = (time.time() - start) * 1000
        return context, duration_ms

    def memos_search(self, client, query, conv_id, speaker_a, speaker_b, reversed_client=None):
        """
        Search memories using the memos framework.

        Args:
            client: memos client instance
            query: Search query string
            conv_id: Conversation ID
            speaker_a: First speaker identifier
            speaker_b: Second speaker identifier
            reversed_client: Client instance for reversed speaker context

        Returns:
            Tuple containing formatted context and search duration in milliseconds
        """
        start = time.time()
        # Search memories for speaker A
        search_a_results = client.search(
            query=query,
            user_id=conv_id + "_speaker_a",
        )
        filtered_search_a_results = filter_memory_data(search_a_results)["text_mem"][0]["memories"]
        speaker_a_context = ""
        for item in filtered_search_a_results:
            speaker_a_context += f"{item['memory']}\n"

        # Search memories for speaker B
        search_b_results = reversed_client.search(
            query=query,
            user_id=conv_id + "_speaker_b",
        )
        filtered_search_b_results = filter_memory_data(search_b_results)["text_mem"][0]["memories"]
        speaker_b_context = ""
        for item in filtered_search_b_results:
            speaker_b_context += f"{item['memory']}\n"

        # Create context using template
        context = SEARCH_PROMPT_MEMOS.format(
            speaker_1=speaker_a,
            speaker_1_memories=speaker_a_context,
            speaker_2=speaker_b,
            speaker_2_memories=speaker_b_context,
        )

        duration_ms = (time.time() - start) * 1000
        return context, duration_ms

    def memos_scheduler_search(
        self, client, query, conv_id, speaker_a, speaker_b, reversed_client=None
    ):
        start = time.time()
        client: MOS = client

        # Search for speaker A
        search_a_results = client.mem_scheduler.search_for_eval(
            query=query,
            user_id=conv_id + "_speaker_a",
            top_k=client.config.top_k,
            scheduler_flag=self.scheduler_flag,
        )

        # Search for speaker B
        search_b_results = reversed_client.mem_scheduler.search_for_eval(
            query=query,
            user_id=conv_id + "_speaker_b",
            top_k=client.config.top_k,
            scheduler_flag=self.scheduler_flag,
        )

        speaker_a_context = ""
        for item in search_a_results:
            speaker_a_context += f"{item}\n"

        speaker_b_context = ""
        for item in search_b_results:
            speaker_b_context += f"{item}\n"

        context = SEARCH_PROMPT_MEMOS.format(
            speaker_1=speaker_a,
            speaker_1_memories=speaker_a_context,
            speaker_2=speaker_b,
            speaker_2_memories=speaker_b_context,
        )

        logger.info(f'query "{query[:100]}", context: {context[:100]}"')
        duration_ms = (time.time() - start) * 1000

        return context, duration_ms

    def mem0_graph_search(self, client, query, speaker_a_user_id, speaker_b_user_id, top_k=20):
        start = time.time()
        search_speaker_a_results = client.search(
            query=query,
            top_k=top_k,
            user_id=speaker_a_user_id,
            output_format="v1.1",
            version="v2",
            enable_graph=True,
            filters={"AND": [{"user_id": f"{speaker_a_user_id}"}, {"run_id": "*"}]},
        )
        search_speaker_b_results = client.search(
            query=query,
            top_k=top_k,
            user_id=speaker_b_user_id,
            output_format="v1.1",
            version="v2",
            enable_graph=True,
            filters={"AND": [{"user_id": f"{speaker_b_user_id}"}, {"run_id": "*"}]},
        )

        search_speaker_a_memory = [
            {
                "memory": memory["memory"],
                "timestamp": memory["created_at"],
                "score": round(memory["score"], 2),
            }
            for memory in search_speaker_a_results["results"]
        ]

        search_speaker_a_memory = [
            [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_a_memory]
        ]

        search_speaker_b_memory = [
            {
                "memory": memory["memory"],
                "timestamp": memory["created_at"],
                "score": round(memory["score"], 2),
            }
            for memory in search_speaker_b_results["results"]
        ]

        search_speaker_b_memory = [
            [f"{item['timestamp']}: {item['memory']}" for item in search_speaker_b_memory]
        ]

        search_speaker_a_graph = [
            {
                "source": relation["source"],
                "relationship": relation["relationship"],
                "target": relation["target"],
            }
            for relation in search_speaker_a_results["relations"]
        ]

        search_speaker_b_graph = [
            {
                "source": relation["source"],
                "relationship": relation["relationship"],
                "target": relation["target"],
            }
            for relation in search_speaker_b_results["relations"]
        ]
        context = SEARCH_PROMPT_MEM0_GRAPH.format(
            speaker_1_user_id=speaker_a_user_id.split("_")[0],
            speaker_1_memories=json.dumps(search_speaker_a_memory, indent=4),
            speaker_1_graph_memories=json.dumps(search_speaker_a_graph, indent=4),
            speaker_2_user_id=speaker_b_user_id.split("_")[0],
            speaker_2_memories=json.dumps(search_speaker_b_memory, indent=4),
            speaker_2_graph_memories=json.dumps(search_speaker_b_graph, indent=4),
        )
        print(query, context)
        duration_ms = (time.time() - start) * 1000
        return context, duration_ms

    def zep_search(self, client, query, group_id, top_k=20):
        start = time.time()
        nodes_result = client.graph.search(
            query=query,
            group_id=group_id,
            scope="nodes",
            reranker="rrf",
            limit=top_k,
        )
        edges_result = client.graph.search(
            query=query,
            group_id=group_id,
            scope="edges",
            reranker="cross_encoder",
            limit=top_k,
        )

        nodes = nodes_result.nodes
        edges = edges_result.edges

        facts = [f"  - {edge.fact} (event_time: {edge.valid_at})" for edge in edges]
        entities = [f"  - {node.name}: {node.summary}" for node in nodes]

        context = SEARCH_PROMPT_ZEP.format(facts="\n".join(facts), entities="\n".join(entities))

        duration_ms = (time.time() - start) * 1000

        return context, duration_ms

    def search_query(self, client, query, metadata, frame, reversed_client=None, top_k=20):
        conv_id = metadata.get("conv_id")
        speaker_a = metadata.get("speaker_a")
        speaker_b = metadata.get("speaker_b")
        speaker_a_user_id = metadata.get("speaker_a_user_id")
        speaker_b_user_id = metadata.get("speaker_b_user_id")

        if frame == "zep":
            context, duration_ms = self.zep_search(client, query, conv_id, top_k)
        elif frame == "mem0":
            context, duration_ms = self.mem0_search(
                client, query, speaker_a_user_id, speaker_b_user_id, top_k
            )
        elif frame == "mem0_graph":
            context, duration_ms = self.mem0_graph_search(
                client, query, speaker_a_user_id, speaker_b_user_id, top_k
            )
        elif frame == "memos":
            context, duration_ms = self.memos_search(
                client, query, conv_id, speaker_a, speaker_b, reversed_client
            )
        elif frame == "memos_scheduler":
            context, duration_ms = self.memos_scheduler_search(
                client, query, conv_id, speaker_a, speaker_b, reversed_client
            )
        else:
            raise NotImplementedError()

        return context, duration_ms
