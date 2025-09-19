"""Internet retrieval module for tree text memory."""

import uuid

from datetime import datetime

import requests

from memos.embedders.factory import OllamaEmbedder
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


class GoogleCustomSearchAPI:
    """Google Custom Search API Client"""

    def __init__(
        self, api_key: str, search_engine_id: str, max_results: int = 20, num_per_request: int = 10
    ):
        """
        Initialize Google Custom Search API client

        Args:
            api_key: Google API key
            search_engine_id: Search engine ID (cx parameter)
            max_results: Maximum number of results to retrieve
            num_per_request: Number of results per API request
        """
        self.api_key = api_key
        self.search_engine_id = search_engine_id
        self.max_results = max_results
        self.num_per_request = min(num_per_request, 10)  # Google API limits to 10
        self.base_url = "https://www.googleapis.com/customsearch/v1"

    def search(self, query: str, num_results: int | None = None, start_index: int = 1) -> dict:
        """
        Execute search request

        Args:
            query: Search query
            num_results: Number of results to return (uses config default if None)
            start_index: Starting index (default 1)

        Returns:
            Dictionary containing search results
        """
        if num_results is None:
            num_results = self.num_per_request

        params = {
            "key": self.api_key,
            "cx": self.search_engine_id,
            "q": query,
            "num": min(num_results, self.num_per_request),
            "start": start_index,
        }

        try:
            response = requests.get(self.base_url, params=params)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"Google search request failed: {e}")
            return {}

    def get_all_results(self, query: str, max_results: int | None = None) -> list[dict]:
        """
        Get all search results (with pagination)

        Args:
            query: Search query
            max_results: Maximum number of results (uses config default if None)

        Returns:
            List of all search results
        """
        if max_results is None:
            max_results = self.max_results

        all_results = []
        start_index = 1

        while len(all_results) < max_results:
            search_data = self.search(query, start_index=start_index)

            if not search_data or "items" not in search_data:
                break

            all_results.extend(search_data["items"])

            # Check if there are more results
            if len(search_data["items"]) < self.num_per_request:
                break

            start_index += self.num_per_request

            # Avoid infinite loop
            if start_index > 100:
                break

        return all_results[:max_results]


class InternetGoogleRetriever:
    """Internet retriever that converts search results to TextualMemoryItem format"""

    def __init__(
        self,
        api_key: str,
        search_engine_id: str,
        embedder: OllamaEmbedder,
        max_results: int = 20,
        num_per_request: int = 10,
    ):
        """
        Initialize internet retriever

        Args:
            api_key: Google API key
            search_engine_id: Search engine ID
            embedder: Embedder instance for generating embeddings
            max_results: Maximum number of results to retrieve
            num_per_request: Number of results per API request
        """
        self.google_api = GoogleCustomSearchAPI(
            api_key, search_engine_id, max_results=max_results, num_per_request=num_per_request
        )
        self.embedder = embedder

    def retrieve_from_internet(
        self, query: str, top_k: int = 10, parsed_goal=None, info=None
    ) -> list[TextualMemoryItem]:
        """
        Retrieve information from the internet and convert to TextualMemoryItem format

        Args:
            query: Search query
            top_k: Number of results to return
            parsed_goal: Parsed task goal (optional)
            info (dict): Leave a record of memory consumption.

        Returns:
            List of TextualMemoryItem
        """
        if not info:
            info = {"user_id": "", "session_id": ""}
        # Get search results
        search_results = self.google_api.get_all_results(query, max_results=top_k)

        # Convert to TextualMemoryItem format
        memory_items = []

        for _, result in enumerate(search_results):
            # Extract basic information
            title = result.get("title", "")
            snippet = result.get("snippet", "")
            link = result.get("link", "")
            display_link = result.get("displayLink", "")

            # Combine memory content
            memory_content = f"Title: {title}\nSummary: {snippet}\nSource: {link}"
            # Create metadata
            metadata = TreeNodeTextualMemoryMetadata(
                user_id=info.get("user_id", ""),
                session_id=info.get("session_id", ""),
                status="activated",
                type="fact",  # Internet search results are usually factual information
                memory_time=datetime.now().strftime("%Y-%m-%d"),
                source="web",
                confidence=85.0,  # Confidence level for internet information
                entities=self._extract_entities(title, snippet),
                tags=self._extract_tags(title, snippet, parsed_goal),
                visibility="public",
                memory_type="LongTermMemory",  # Internet search results as working memory
                key=title,
                sources=[SourceMessage(type="web", url=link)] if link else [],
                embedding=self.embedder.embed([memory_content])[0],  # Can add embedding later
                created_at=datetime.now().isoformat(),
                usage=[],
                background=f"Internet search result from {display_link}",
            )

            # Create TextualMemoryItem
            memory_item = TextualMemoryItem(
                id=str(uuid.uuid4()), memory=memory_content, metadata=metadata
            )

            memory_items.append(memory_item)

        return memory_items

    def _extract_entities(self, title: str, snippet: str) -> list[str]:
        """
        Extract entities from title and snippet

        Args:
            title: Title
            snippet: Snippet

        Returns:
            List of entities
        """
        # Simple entity extraction logic, can be improved as needed
        text = f"{title} {snippet}"
        entities = []

        # Extract possible organization names (with common suffixes)
        org_suffixes = ["Inc", "Corp", "LLC", "Ltd", "Company", "University", "Institute"]
        words = text.split()
        for i, word in enumerate(words):
            if word in org_suffixes and i > 0:
                entities.append(f"{words[i - 1]} {word}")

        # Extract possible dates
        import re

        date_pattern = r"\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4}|\w+ \d{1,2}, \d{4}"
        dates = re.findall(date_pattern, text)
        entities.extend(dates)

        return entities[:5]  # Limit number of entities

    def _extract_tags(self, title: str, snippet: str, parsed_goal=None) -> list[str]:
        """
        Extract tags from title and snippet

        Args:
            title: Title
            snippet: Snippet
            parsed_goal: Parsed task goal

        Returns:
            List of tags
        """
        tags = []

        # Extract tags from parsed goal
        if parsed_goal:
            if hasattr(parsed_goal, "topic") and parsed_goal.topic:
                tags.append(parsed_goal.topic)
            if hasattr(parsed_goal, "concept") and parsed_goal.concept:
                tags.append(parsed_goal.concept)

        # Extract keywords from text
        text = f"{title} {snippet}".lower()

        # Simple keyword extraction
        keywords = [
            "news",
            "report",
            "article",
            "study",
            "research",
            "analysis",
            "update",
            "announcement",
            "policy",
            "memo",
            "document",
        ]

        for keyword in keywords:
            if keyword in text:
                tags.append(keyword)

        # Remove duplicates and limit count
        return list(set(tags))[:10]
