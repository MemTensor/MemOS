"""Keenable Search API retriever for tree text memory."""

from concurrent.futures import as_completed
from datetime import datetime
from typing import Any

import requests

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.log import get_logger
from memos.mem_reader.read_multi_modal import detect_lang
from memos.memories.textual.item import (
    SearchedTreeNodeTextualMemoryMetadata,
    SourceMessage,
    TextualMemoryItem,
)


logger = get_logger(__name__)

# Hardcoded Keenable API base (not configurable — prevents SSRF).
KEENABLE_BASE_URL = "https://api.keenable.ai"


class InternetKeenableRetriever:
    """Keenable retriever that converts search results into TextualMemoryItem objects.

    Keyless by default: with no API key it calls the public endpoint
    (rate-limited); a key switches to the authenticated endpoint and lifts the cap.
    """

    def __init__(
        self,
        api_key: str | None,
        embedder: OllamaEmbedder,
        max_results: int = 10,
    ):
        """
        Initialize the Keenable Search retriever.

        Args:
            api_key: Keenable API key. Optional — keyless when empty/None.
            embedder: Embedder instance for generating embeddings
            max_results: Maximum number of search results to retrieve
        """
        self.api_key = (api_key or "").strip()
        self.embedder = embedder
        self.max_results = max_results
        self.timeout = 15

        import jieba.analyse

        self.zh_fast_keywords_extractor = jieba.analyse.TextRank()

    def _extract_tags(self, title: str, content: str, summary: str, parsed_goal=None) -> list[str]:
        """Extract tags from title, content and summary."""
        tags = []

        tags.append("keenable_search")
        tags.append("news")

        text = f"{title} {content} {summary}".lower()

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

        if parsed_goal and hasattr(parsed_goal, "tags"):
            tags.extend(parsed_goal.tags)

        return list(set(tags))[:15]

    def retrieve_from_internet(
        self, query: str, top_k: int = 10, parsed_goal=None, info=None, mode="fast"
    ) -> list[TextualMemoryItem]:
        """
        Retrieve results from the internet using the Keenable Search API.

        Args:
            query: Search query
            top_k: Number of results to retrieve
            parsed_goal: Parsed task goal (optional)
            info (dict): Metadata for memory consumption tracking
            mode: Retrieval mode ('fast' or other)

        Returns:
            List of TextualMemoryItem
        """
        # Keyless by default; a configured key switches to the authenticated path.
        path = "/v1/search" if self.api_key else "/v1/search/public"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Keenable-Title": "MemOS",
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        limit = min(top_k, self.max_results)
        try:
            resp = requests.post(
                f"{KEENABLE_BASE_URL}{path}",
                json={"query": query, "mode": "pro"},
                headers=headers,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            raw_results = resp.json().get("results", [])[:limit]
        except Exception:
            import traceback

            logger.error(f"Keenable search error: {traceback.format_exc()}")
            return []

        # Normalize Keenable results into the shape _process_result expects.
        search_results = [
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "content": r.get("description", ""),
                "published_date": r.get("published_at", ""),
            }
            for r in raw_results
        ]

        return self._convert_to_mem_items(search_results, query, parsed_goal, info, mode=mode)

    def _convert_to_mem_items(
        self, search_results: list[dict], query: str, parsed_goal=None, info=None, mode="fast"
    ):
        """Convert Keenable search results into TextualMemoryItem objects."""
        memory_items = []
        if not info:
            info = {"user_id": "", "session_id": ""}

        with ContextThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(self._process_result, r, query, parsed_goal, info, mode=mode)
                for r in search_results
            ]
            for future in as_completed(futures):
                try:
                    memory_items.extend(future.result())
                except Exception as e:
                    logger.error(f"Error processing Keenable search result: {e}")

        unique_memory_items = {item.memory: item for item in memory_items}
        return list(unique_memory_items.values())

    def _process_result(
        self, result: dict, query: str, parsed_goal: str, info: dict[str, Any], mode="fast"
    ) -> list[TextualMemoryItem]:
        """Process one Keenable search result into TextualMemoryItem."""
        title = result.get("title", "")
        content = result.get("content", "")
        url = result.get("url", "")
        publish_time = result.get("published_date", "")

        if publish_time:
            try:
                publish_time = datetime.fromisoformat(publish_time.replace("Z", "+00:00")).strftime(
                    "%Y-%m-%d"
                )
            except Exception:
                publish_time = datetime.now().strftime("%Y-%m-%d")
        else:
            publish_time = datetime.now().strftime("%Y-%m-%d")

        summary = content[:500] if content else ""

        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")
        lang = detect_lang(summary)
        tags = (
            self.zh_fast_keywords_extractor.textrank(summary, topK=3)[:3]
            if lang == "zh"
            else self._extract_tags(title, content, summary)[:3]
        )

        if mode == "fast":
            memory_text = (
                f"[Outer internet view] Title: {title}\nNewsTime: {publish_time}\nSummary: {summary}\n"
            )
        else:
            memory_text = (
                f"[Outer internet view] Title: {title}\nNewsTime: {publish_time}\nSummary:"
                f" {summary}\nContent: {content}"
            )

        return [
            TextualMemoryItem(
                memory=memory_text,
                metadata=SearchedTreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type="OuterMemory",
                    status="activated",
                    type="fact",
                    source="web",
                    sources=[SourceMessage(type="web", url=url)] if url else [],
                    visibility="public",
                    info=info_,
                    background="",
                    confidence=0.99,
                    usage=[],
                    tags=tags,
                    key=title,
                    embedding=self.embedder.embed([content])[0],
                    internet_info={
                        "title": title,
                        "url": url,
                        "site_name": "",
                        "site_icon": None,
                        "summary": summary,
                    },
                ),
            )
        ]
