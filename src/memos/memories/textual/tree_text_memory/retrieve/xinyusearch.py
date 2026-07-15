"""Xinyu Search API retriever for tree text memory."""

import json
import uuid

from concurrent.futures import as_completed
from datetime import datetime

import requests

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.log import get_logger
from memos.mem_reader.base import BaseMemReader
from memos.memories.textual.item import (
    SearchedTreeNodeTextualMemoryMetadata,
    SourceMessage,
    TextualMemoryItem,
)


logger = get_logger(__name__)


class XinyuSearchAPI:
    """Xinyu Search API Client"""

    def __init__(self, access_key: str, search_engine_id: str, max_results: int = 20):
        """
        Initialize Xinyu Search API client

        Args:
            access_key: Xinyu API access key
            max_results: Maximum number of results to retrieve
        """
        self.access_key = access_key
        self.max_results = max_results

        # API configuration
        self.config = {"url": search_engine_id}

        self.headers = {
            "User-Agent": "PostmanRuntime/7.39.0",
            "Content-Type": "application/json",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "token": access_key,
        }

    def query_detail(self, body: dict | None = None, detail: bool = True) -> list[dict]:
        """
        Query Xinyu search API for detailed results

        Args:
            body: Search parameters
            detail: Whether to get detailed results

        Returns:
            List of search results
        """
        res = []
        try:
            url = self.config["url"]

            params = json.dumps(body)
            resp = requests.request("POST", url, headers=self.headers, data=params)
            res = json.loads(resp.text)["results"]

            # If detail interface, return online part
            if "search_type" in body:
                res = res["online"]

            if not detail:
                for res_i in res:
                    res_i["summary"] = "「SUMMARY」" + res_i.get("summary", "")

        except Exception:
            import traceback

            logger.error(f"xinyu search error: {traceback.format_exc()}")
        return res

    def search(self, query: str, max_results: int | None = None) -> list[dict]:
        """
        Execute search request

        Args:
            query: Search query
            max_results: Maximum number of results to return

        Returns:
            List of search results
        """
        if max_results is None:
            max_results = self.max_results

        body = {
            "search_type": ["online"],
            "online_search": {
                "max_entries": max_results,
                "cache_switch": False,
                "baidu_field": {"switch": False, "mode": "relevance", "type": "page"},
                "bing_field": {"switch": True, "mode": "relevance", "type": "page"},
                "sogou_field": {"switch": False, "mode": "relevance", "type": "page"},
            },
            "request_id": "memos" + str(uuid.uuid4()),
            "queries": query,
        }

        return self.query_detail(body)


class XinyuSearchRetriever:
    """Xinyu Search retriever that converts search results to TextualMemoryItem format"""

    def __init__(
        self,
        access_key: str,
        search_engine_id: str,
        embedder: OllamaEmbedder,
        reader: BaseMemReader,
        max_results: int = 20,
    ):
        """
        Initialize Xinyu search retriever

        Args:
            access_key: Xinyu API access key
            embedder: Embedder instance for generating embeddings
            max_results: Maximum number of results to retrieve
            reader: MemReader Moduel to deal with internet contents
        """
        self.xinyu_api = XinyuSearchAPI(access_key, search_engine_id, max_results=max_results)
        self.embedder = embedder
        self.reader = reader

    def retrieve_from_internet(
        self, query: str, top_k: int = 10, parsed_goal=None, info=None, mode="fast"
    ) -> list[TextualMemoryItem]:
        """
        Retrieve information from Xinyu search and convert to TextualMemoryItem format

        Args:
            query: Search query
            top_k: Number of results to return
            parsed_goal: Parsed task goal (optional)
            info (dict): Leave a record of memory consumption.
        Returns:
            List of TextualMemoryItem
        """
        # Get search results
        search_results = self.xinyu_api.search(query, max_results=top_k)

        # Convert to TextualMemoryItem format
        memory_items: list[TextualMemoryItem] = []

        with ContextThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(self._process_result, result, query, parsed_goal, info, mode=mode)
                for result in search_results
            ]
            for future in as_completed(futures):
                try:
                    memory_items.extend(future.result())
                except Exception as e:
                    logger.error(f"Error processing search result: {e}")

        unique_memory_items = {}
        for item in memory_items:
            if item.memory not in unique_memory_items:
                unique_memory_items[item.memory] = item

        return list(unique_memory_items.values())

    def _extract_entities(self, title: str, content: str, summary: str) -> list[str]:
        """
        Extract entities from title, content and summary

        Args:
            title: Article title
            content: Article content
            summary: Article summary

        Returns:
            List of extracted entities
        """
        # Simple entity extraction - can be enhanced with NER
        text = f"{title} {content} {summary}"
        entities = []

        # Extract potential entities (simple approach)
        # This can be enhanced with proper NER models
        words = text.split()
        for word in words:
            if len(word) > 2 and word[0].isupper():
                entities.append(word)

        return list(set(entities))[:10]  # Limit to 10 entities

    def _extract_tags(self, title: str, content: str, summary: str, parsed_goal=None) -> list[str]:
        """
        Extract tags from title, content and summary

        Args:
            title: Article title
            content: Article content
            summary: Article summary
            parsed_goal: Parsed task goal (optional)

        Returns:
            List of extracted tags
        """
        tags = []

        # Add source-based tags
        tags.append("xinyu_search")
        tags.append("news")

        # Add content-based tags
        text = f"{title} {content} {summary}".lower()

        # Simple keyword-based tagging
        keywords = {
            "economy": [
                "economy",
                "GDP",
                "growth",
                "production",
                "industry",
                "investment",
                "consumption",
                "market",
                "trade",
                "finance",
            ],
            "politics": [
                "politics",
                "government",
                "policy",
                "meeting",
                "leader",
                "election",
                "parliament",
                "ministry",
            ],
            "technology": [
                "technology",
                "tech",
                "innovation",
                "digital",
                "internet",
                "AI",
                "artificial intelligence",
                "software",
                "hardware",
            ],
            "sports": [
                "sports",
                "game",
                "athlete",
                "olympic",
                "championship",
                "tournament",
                "team",
                "player",
            ],
            "culture": [
                "culture",
                "education",
                "art",
                "history",
                "literature",
                "music",
                "film",
                "museum",
            ],
            "health": [
                "health",
                "medical",
                "pandemic",
                "hospital",
                "doctor",
                "medicine",
                "disease",
                "treatment",
            ],
            "environment": [
                "environment",
                "ecology",
                "pollution",
                "green",
                "climate",
                "sustainability",
                "renewable",
            ],
        }

        for category, words in keywords.items():
            if any(word in text for word in words):
                tags.append(category)

        # Add goal-based tags if available
        if parsed_goal and hasattr(parsed_goal, "tags"):
            tags.extend(parsed_goal.tags)

        return list(set(tags))[:15]  # Limit to 15 tags

    def _process_result(
        self, result: dict, query: str, parsed_goal: str, info: None, mode="fast"
    ) -> list[TextualMemoryItem]:
        if not info:
            info = {"user_id": "", "session_id": ""}
        title = result.get("title", "")
        content = result.get("content", "")
        summary = result.get("summary", "")
        url = result.get("url", "")
        publish_time = result.get("publish_time", "")
        if publish_time:
            try:
                publish_time = datetime.strptime(publish_time, "%Y-%m-%d %H:%M:%S").strftime(
                    "%Y-%m-%d"
                )
            except Exception as e:
                logger.error(f"xinyu search error: {e}")
                publish_time = datetime.now().strftime("%Y-%m-%d")
        else:
            publish_time = datetime.now().strftime("%Y-%m-%d")

        if mode == "fast":
            info_ = info.copy()
            user_id = info_.pop("user_id", "")
            session_id = info_.pop("session_id", "")
            return [
                TextualMemoryItem(
                    memory=(
                        f"[Outer internet view] Title: {title}\nNewsTime:"
                        f" {publish_time}\nSummary:"
                        f" {summary}\n"
                    ),
                    metadata=SearchedTreeNodeTextualMemoryMetadata(
                        user_id=user_id,
                        session_id=session_id,
                        memory_type="OuterMemory",
                        status="activated",
                        type="fact",
                        source="web",
                        sources=[SourceMessage(type="web", url=url)] if url else [],
                        visibility="public",
                        tags=self._extract_tags(title, content, summary),
                        key=title,
                        info=info_,
                        background="",
                        confidence=0.99,
                        usage=[],
                        embedding=self.embedder.embed([content])[0],
                        internet_info={
                            "title": title,
                            "url": url,
                            "summary": summary,
                            "content": content,
                        },
                    ),
                )
            ]
        else:
            read_items = self.reader.get_memory([content], type="doc", info=info)

            memory_items = []
            for read_item_i in read_items[0]:
                read_item_i.memory = (
                    f"Title: {title}\nNewsTime: {publish_time}\nSummary: {summary}\n"
                    f"Content: {read_item_i.memory}"
                )
                read_item_i.metadata.source = "web"
                read_item_i.metadata.memory_type = "OuterMemory"
                read_item_i.metadata.sources = [SourceMessage(type="web", url=url)] if url else []
                read_item_i.metadata.visibility = "public"
                read_item_i.metadata.internet_info = {
                    "title": title,
                    "url": url,
                    "summary": summary,
                    "content": content,
                }

                memory_items.append(read_item_i)
            return memory_items
