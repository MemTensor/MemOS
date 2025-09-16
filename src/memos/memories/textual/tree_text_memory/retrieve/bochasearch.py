"""BochaAI Search API retriever for tree text memory."""

import json

from concurrent.futures import as_completed
from datetime import datetime
from typing import Any

import requests

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.log import get_logger
from memos.mem_reader.base import BaseMemReader
from memos.memories.textual.item import SourceMessage, TextualMemoryItem


logger = get_logger(__name__)


class BochaAISearchAPI:
    """BochaAI Search API Client"""

    def __init__(self, api_key: str, max_results: int = 20):
        """
        Initialize BochaAI Search API client.

        Args:
            api_key: BochaAI API key
            max_results: Maximum number of search results to retrieve
        """
        self.api_key = api_key
        self.max_results = max_results

        self.web_url = "https://api.bochaai.com/v1/web-search"
        self.ai_url = "https://api.bochaai.com/v1/ai-search"

        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def search_web(self, query: str, summary: bool = True, freshness="noLimit") -> list[dict]:
        """
        Perform a Web Search (equivalent to the first curl).

        Args:
            query: Search query string
            summary: Whether to include summary in the results
            freshness: Freshness filter (e.g. 'noLimit', 'day', 'week')

        Returns:
            A list of search result dicts
        """
        body = {
            "query": query,
            "summary": summary,
            "freshness": freshness,
            "count": self.max_results,
        }
        return self._post(self.web_url, body)

    def search_ai(
        self, query: str, answer: bool = False, stream: bool = False, freshness="noLimit"
    ) -> list[dict]:
        """
        Perform an AI Search (equivalent to the second curl).

        Args:
            query: Search query string
            answer: Whether BochaAI should generate an answer
            stream: Whether to use streaming response
            freshness: Freshness filter (e.g. 'noLimit', 'day', 'week')

        Returns:
            A list of search result dicts
        """
        body = {
            "query": query,
            "freshness": freshness,
            "count": self.max_results,
            "answer": answer,
            "stream": stream,
        }
        return self._post(self.ai_url, body)

    def _post(self, url: str, body: dict) -> list[dict]:
        """Send POST request and parse BochaAI search results."""
        try:
            resp = requests.post(url, headers=self.headers, json=body)
            resp.raise_for_status()
            raw_data = resp.json()

            # parse the nested structure correctly
            # ✅ AI Search
            if "messages" in raw_data:
                results = []
                for msg in raw_data["messages"]:
                    if msg.get("type") == "source" and msg.get("content_type") == "webpage":
                        try:
                            content_json = json.loads(msg["content"])
                            results.extend(content_json.get("value", []))
                        except Exception as e:
                            logger.error(f"Failed to parse message content: {e}")
                return results

            # ✅ Web Search
            return raw_data.get("data", {}).get("webPages", {}).get("value", [])

        except Exception:
            import traceback

            logger.error(f"BochaAI search error: {traceback.format_exc()}")
            return []


class BochaAISearchRetriever:
    """BochaAI retriever that converts search results into TextualMemoryItem objects"""

    def __init__(
        self,
        access_key: str,
        embedder: OllamaEmbedder,
        reader: BaseMemReader,
        max_results: int = 20,
    ):
        """
        Initialize BochaAI Search retriever.

        Args:
            access_key: BochaAI API key
            embedder: Embedder instance for generating embeddings
            reader: MemReader instance for processing internet content
            max_results: Maximum number of search results to retrieve
        """
        self.bocha_api = BochaAISearchAPI(access_key, max_results=max_results)
        self.embedder = embedder
        self.reader = reader

    def retrieve_from_internet(
        self, query: str, top_k: int = 10, parsed_goal=None, info=None
    ) -> list[TextualMemoryItem]:
        """
        Default internet retrieval (Web Search).
        This keeps consistent API with Xinyu and Google retrievers.

        Args:
            query: Search query
            top_k: Number of results to retrieve
            parsed_goal: Parsed task goal (optional)
            info (dict): Metadata for memory consumption tracking

        Returns:
            List of TextualMemoryItem
        """
        search_results = self.bocha_api.search_ai(query)  # ✅ default to
        # web-search
        return self._convert_to_mem_items(search_results, query, parsed_goal, info)

    def retrieve_from_web(
        self, query: str, top_k: int = 10, parsed_goal=None, info=None
    ) -> list[TextualMemoryItem]:
        """Explicitly retrieve using Bocha Web Search."""
        search_results = self.bocha_api.search_web(query)
        return self._convert_to_mem_items(search_results, query, parsed_goal, info)

    def retrieve_from_ai(
        self, query: str, top_k: int = 10, parsed_goal=None, info=None
    ) -> list[TextualMemoryItem]:
        """Explicitly retrieve using Bocha AI Search."""
        search_results = self.bocha_api.search_ai(query)
        return self._convert_to_mem_items(search_results, query, parsed_goal, info)

    def _convert_to_mem_items(
        self, search_results: list[dict], query: str, parsed_goal=None, info=None
    ):
        """Convert API search results into TextualMemoryItem objects."""
        memory_items = []
        if not info:
            info = {"user_id": "", "session_id": ""}

        with ContextThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(self._process_result, r, query, parsed_goal, info)
                for r in search_results
            ]
            for future in as_completed(futures):
                try:
                    memory_items.extend(future.result())
                except Exception as e:
                    logger.error(f"Error processing BochaAI search result: {e}")

        # Deduplicate items by memory text
        unique_memory_items = {item.memory: item for item in memory_items}
        return list(unique_memory_items.values())

    def _process_result(
        self, result: dict, query: str, parsed_goal: str, info: dict[str, Any]
    ) -> list[TextualMemoryItem]:
        """Process one Bocha search result into TextualMemoryItem."""
        title = result.get("name", "")
        content = result.get("summary", "") or result.get("snippet", "")
        summary = result.get("snippet", "")
        url = result.get("url", "")
        publish_time = result.get("datePublished", "")

        if publish_time:
            try:
                publish_time = datetime.fromisoformat(publish_time.replace("Z", "+00:00")).strftime(
                    "%Y-%m-%d"
                )
            except Exception:
                publish_time = datetime.now().strftime("%Y-%m-%d")
        else:
            publish_time = datetime.now().strftime("%Y-%m-%d")

        # Use reader to split and process the content into chunks
        read_items = self.reader.get_memory([content], type="doc", info=info)

        memory_items = []
        for read_item_i in read_items[0]:
            read_item_i.memory = (
                f"[Outer internet view] Title: {title}\nNewsTime:"
                f" {publish_time}\nSummary:"
                f" {summary}\n"
                f"Content: {read_item_i.memory}"
            )
            read_item_i.metadata.source = "web"
            read_item_i.metadata.memory_type = "OuterMemory"
            read_item_i.metadata.sources = [SourceMessage(type="web", url=url)] if url else []
            read_item_i.metadata.visibility = "public"
            memory_items.append(read_item_i)
        return memory_items
