"""Xinyu Search API retriever for tree text memory."""

import json
import uuid

from datetime import datetime

import requests

from memos.embedders.factory import OllamaEmbedder
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


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
                "baidu_field": {"switch": True, "mode": "relevance", "type": "page"},
                "bing_field": {"switch": False, "mode": "relevance", "type": "page_web"},
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
        max_results: int = 20,
    ):
        """
        Initialize Xinyu search retriever

        Args:
            access_key: Xinyu API access key
            embedder: Embedder instance for generating embeddings
            max_results: Maximum number of results to retrieve
        """
        self.xinyu_api = XinyuSearchAPI(access_key, search_engine_id, max_results=max_results)
        self.embedder = embedder

    def retrieve_from_internet(
        self, query: str, top_k: int = 10, parsed_goal=None
    ) -> list[TextualMemoryItem]:
        """
        Retrieve information from Xinyu search and convert to TextualMemoryItem format

        Args:
            query: Search query
            top_k: Number of results to return
            parsed_goal: Parsed task goal (optional)

        Returns:
            List of TextualMemoryItem
        """
        # Get search results
        search_results = self.xinyu_api.search(query, max_results=top_k)

        # Convert to TextualMemoryItem format
        memory_items = []

        for _, result in enumerate(search_results):
            # Extract basic information from Xinyu response format
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
            source = result.get("source", "")
            site = result.get("site", "")
            if site:
                site = site.split("|")[0]

            # Combine memory content
            memory_content = (
                f"Title: {title}\nSummary: {summary}\nContent: {content[:200]}...\nSource: {url}"
            )

            # Create metadata
            metadata = TreeNodeTextualMemoryMetadata(
                user_id=None,
                session_id=None,
                status="activated",
                type="fact",  # Search results are usually factual information
                memory_time=publish_time,
                source="web",
                confidence=85.0,  # Confidence level for search information
                entities=self._extract_entities(title, content, summary),
                tags=self._extract_tags(title, content, summary, parsed_goal),
                visibility="public",
                memory_type="LongTermMemory",  # Search results as working memory
                key=title,
                sources=[url] if url else [],
                embedding=self.embedder.embed([memory_content])[0],
                created_at=datetime.now().isoformat(),
                usage=[],
                background=f"Xinyu search result from {site or source}",
            )
            # Create TextualMemoryItem
            memory_item = TextualMemoryItem(
                id=str(uuid.uuid4()), memory=memory_content, metadata=metadata
            )

            memory_items.append(memory_item)

        return memory_items

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
