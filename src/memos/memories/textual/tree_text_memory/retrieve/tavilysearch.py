"""Tavily Search API retriever for tree text memory."""

from concurrent.futures import as_completed
from datetime import datetime
from typing import Any

from memos.context.context import ContextThreadPoolExecutor
from memos.dependency import require_python_package
from memos.embedders.factory import OllamaEmbedder
from memos.log import get_logger
from memos.mem_reader.read_multi_modal import detect_lang
from memos.memories.textual.item import (
    SearchedTreeNodeTextualMemoryMetadata,
    SourceMessage,
    TextualMemoryItem,
)


logger = get_logger(__name__)


class TavilySearchRetriever:
    """Tavily retriever that converts search results into TextualMemoryItem objects."""

    @require_python_package(
        import_name="tavily",
        install_command="pip install tavily-python",
        install_link="https://github.com/tavily-ai/tavily-python",
    )
    @require_python_package(
        import_name="jieba",
        install_command="pip install jieba",
        install_link="https://github.com/fxsjy/jieba",
    )
    def __init__(
        self,
        api_key: str,
        embedder: OllamaEmbedder,
        max_results: int = 20,
    ):
        """
        Initialize Tavily Search retriever.

        Args:
            api_key: Tavily API key
            embedder: Embedder instance for generating embeddings
            max_results: Maximum number of search results to retrieve
        """
        from jieba.analyse import TextRank
        from tavily import TavilyClient

        self.client = TavilyClient(api_key=api_key)
        self.embedder = embedder
        self.max_results = max_results
        self.zh_fast_keywords_extractor = TextRank()

    def _extract_tags(self, title: str, content: str, summary: str, parsed_goal=None) -> list[str]:
        """
        Extract tags from title, content and summary.

        Args:
            title: Article title
            content: Article content
            summary: Article summary
            parsed_goal: Parsed task goal (optional)

        Returns:
            List of extracted tags
        """
        tags = ["tavily_search", "news"]

        text = f"{title} {content} {summary}".lower()

        keywords = {
            "economy": [
                "economy", "GDP", "growth", "production", "industry",
                "investment", "consumption", "market", "trade", "finance",
            ],
            "politics": [
                "politics", "government", "policy", "meeting", "leader",
                "election", "parliament", "ministry",
            ],
            "technology": [
                "technology", "tech", "innovation", "digital", "internet",
                "AI", "artificial intelligence", "software", "hardware",
            ],
            "sports": [
                "sports", "game", "athlete", "olympic", "championship",
                "tournament", "team", "player",
            ],
            "culture": [
                "culture", "education", "art", "history", "literature",
                "music", "film", "museum",
            ],
            "health": [
                "health", "medical", "pandemic", "hospital", "doctor",
                "medicine", "disease", "treatment",
            ],
            "environment": [
                "environment", "ecology", "pollution", "green", "climate",
                "sustainability", "renewable",
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
        Retrieve information from the internet using Tavily Search API.

        Args:
            query: Search query
            top_k: Number of results to retrieve
            parsed_goal: Parsed task goal (optional)
            info (dict): Metadata for memory consumption tracking
            mode: Retrieval mode ("fast" for summaries only)

        Returns:
            List of TextualMemoryItem
        """
        try:
            response = self.client.search(
                query=query,
                max_results=min(top_k, self.max_results),
                search_depth="basic",
                topic="general",
            )
            search_results = response.get("results", [])
        except Exception:
            import traceback

            logger.error(f"Tavily search error: {traceback.format_exc()}")
            search_results = []

        return self._convert_to_mem_items(search_results, query, parsed_goal, info, mode=mode)

    def _convert_to_mem_items(
        self, search_results: list[dict], query: str, parsed_goal=None, info=None, mode="fast"
    ):
        """Convert Tavily search results into TextualMemoryItem objects."""
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
                    logger.error(f"Error processing Tavily search result: {e}")

        # Deduplicate items by memory text
        unique_memory_items = {item.memory: item for item in memory_items}
        return list(unique_memory_items.values())

    def _process_result(
        self, result: dict, query: str, parsed_goal: str, info: dict[str, Any], mode="fast"
    ) -> list[TextualMemoryItem]:
        """Process one Tavily search result into TextualMemoryItem."""
        if mode != "fast":
            logger.warning(
                "TavilySearchRetriever only supports mode=\"fast\"; ignoring mode=%r",
                mode,
            )
        title = result.get("title", "")
        content = result.get("content", "")
        summary = content  # Tavily returns content as the snippet/summary
        url = result.get("url", "")
        publish_time = result.get("published_date", "")

        if publish_time:
            try:
                publish_time = datetime.fromisoformat(
                    publish_time.replace("Z", "+00:00")
                ).strftime("%Y-%m-%d")
            except Exception:
                publish_time = datetime.now().strftime("%Y-%m-%d")
        else:
            publish_time = datetime.now().strftime("%Y-%m-%d")

        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")
        lang = detect_lang(summary)
        tags = (
            self.zh_fast_keywords_extractor.textrank(summary, topK=3)[:3]
            if lang == "zh"
            else self._extract_tags(title, content, summary)[:3]
        )

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
