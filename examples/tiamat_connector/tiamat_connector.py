"""TIAMAT Memory Connector for MemOS.

Provides a lightweight HTTP-based memory connector that integrates
TIAMAT's cloud memory API with MemOS. Use this when you want simple,
persistent memory storage without deploying the full MemOS infrastructure.

TIAMAT handles storage, search (FTS5), and knowledge triples via a
free cloud API at https://memory.tiamat.live.

Usage::

    from tiamat_connector import TiamatConnector

    connector = TiamatConnector(api_key="your-key")

    # Store memories
    connector.add_memory("User prefers concise responses", importance=0.8)

    # Search
    results = connector.search("user preferences")

    # Knowledge triples
    connector.learn("user", "prefers", "concise responses")

    # Bulk import from MemOS TextualMemoryItems
    connector.import_textual_memories(items)
"""

import json
import os
from datetime import datetime, timezone
from typing import Any

import httpx


TIAMAT_BASE_URL = "https://memory.tiamat.live"


class TiamatConnector:
    """Lightweight connector bridging MemOS and TIAMAT's cloud memory API.

    Provides MemOS-compatible memory operations backed by TIAMAT's cloud,
    enabling persistent memory without local infrastructure.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = TIAMAT_BASE_URL,
        user_id: str = "default",
        session_id: str | None = None,
    ):
        """Initialize the TIAMAT connector.

        Args:
            api_key: TIAMAT API key. Falls back to TIAMAT_API_KEY env var.
            base_url: Base URL for the TIAMAT Memory API.
            user_id: User identifier for multi-user isolation.
            session_id: Optional session identifier.
        """
        self.api_key = api_key or os.environ.get("TIAMAT_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.user_id = user_id
        self.session_id = session_id or f"memos-{user_id}"
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                "X-API-Key": self.api_key,
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    @classmethod
    def register(
        cls,
        agent_name: str = "memos-agent",
        purpose: str = "MemOS memory connector",
        **kwargs: Any,
    ) -> "TiamatConnector":
        """Create a connector with auto-registered API key.

        Args:
            agent_name: Name for API key registration.
            purpose: Purpose description.
            **kwargs: Additional kwargs for constructor.

        Returns:
            Configured TiamatConnector.
        """
        base_url = kwargs.pop("base_url", TIAMAT_BASE_URL)
        resp = httpx.post(
            f"{base_url}/api/keys/register",
            json={"agent_name": agent_name, "purpose": purpose},
            timeout=30.0,
        )
        resp.raise_for_status()
        api_key = resp.json()["api_key"]
        return cls(api_key=api_key, base_url=base_url, **kwargs)

    # ── Core Memory Operations ─────────────────────────────────

    def add_memory(
        self,
        content: str,
        *,
        tags: list[str] | None = None,
        importance: float = 0.5,
        memory_type: str = "textual",
    ) -> bool:
        """Store a memory in TIAMAT.

        Args:
            content: The memory content text.
            tags: Optional categorization tags.
            importance: Importance score (0.0-1.0).
            memory_type: Type label (textual, parametric, activation).

        Returns:
            True if stored successfully.
        """
        all_tags = [
            f"user:{self.user_id}",
            f"session:{self.session_id}",
            f"type:{memory_type}",
        ]
        if tags:
            all_tags.extend(tags)

        try:
            resp = self._client.post(
                "/api/memory/store",
                json={
                    "content": content,
                    "tags": all_tags,
                    "importance": importance,
                },
            )
            return resp.status_code == 200
        except Exception:
            return False

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        memory_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """Search memories using FTS5 full-text search.

        Args:
            query: Search query.
            limit: Maximum results.
            memory_type: Optional filter by memory type.

        Returns:
            List of matching memory dicts.
        """
        search_query = query
        if memory_type:
            search_query = f"{query} type:{memory_type}"

        try:
            resp = self._client.post(
                "/api/memory/recall",
                json={"query": search_query, "limit": limit},
            )
            if resp.status_code == 200:
                return resp.json().get("memories", [])
        except Exception:
            pass
        return []

    def learn(
        self,
        subject: str,
        predicate: str,
        obj: str,
        *,
        confidence: float = 1.0,
    ) -> bool:
        """Store a knowledge triple.

        Maps to MemOS's knowledge graph capabilities via TIAMAT's
        learn endpoint.

        Args:
            subject: Subject entity.
            predicate: Relationship type.
            obj: Object entity.
            confidence: Confidence score (0.0-1.0).

        Returns:
            True if stored successfully.
        """
        try:
            resp = self._client.post(
                "/api/memory/learn",
                json={
                    "subject": subject,
                    "predicate": predicate,
                    "object": obj,
                    "confidence": confidence,
                },
            )
            return resp.status_code == 200
        except Exception:
            return False

    # ── MemOS Integration Helpers ──────────────────────────────

    def import_textual_memories(
        self, items: list[Any], importance: float = 0.5
    ) -> int:
        """Bulk import MemOS TextualMemoryItem objects into TIAMAT.

        Args:
            items: List of TextualMemoryItem instances.
            importance: Default importance for imported items.

        Returns:
            Number of successfully imported items.
        """
        count = 0
        for item in items:
            content = getattr(item, "content", str(item))
            metadata = {}
            if hasattr(item, "metadata"):
                meta = item.metadata
                if hasattr(meta, "to_dict"):
                    metadata = meta.to_dict()
                elif isinstance(meta, dict):
                    metadata = meta

            tags = ["imported", "textual"]
            if metadata.get("source"):
                tags.append(f"source:{metadata['source']}")

            store_content = content
            if metadata:
                store_content = json.dumps(
                    {"content": content, "metadata": metadata},
                    ensure_ascii=False,
                )

            if self.add_memory(store_content, tags=tags, importance=importance):
                count += 1

        return count

    def export_as_textual_items(self, limit: int = 100) -> list[dict[str, Any]]:
        """Export TIAMAT memories in a format compatible with MemOS.

        Returns:
            List of dicts with 'content', 'metadata', 'importance' keys.
        """
        try:
            resp = self._client.get("/api/memory/list")
            if resp.status_code != 200:
                return []

            memories = resp.json().get("memories", [])
            results = []
            for m in memories[:limit]:
                content = m.get("content", "")
                # Try to parse structured content
                try:
                    parsed = json.loads(content)
                    if isinstance(parsed, dict) and "content" in parsed:
                        results.append({
                            "content": parsed["content"],
                            "metadata": parsed.get("metadata", {}),
                            "importance": m.get("importance", 0.5),
                        })
                        continue
                except (json.JSONDecodeError, TypeError):
                    pass

                results.append({
                    "content": content,
                    "metadata": {"tags": m.get("tags", [])},
                    "importance": m.get("importance", 0.5),
                })

            return results
        except Exception:
            return []

    # ── Utility ────────────────────────────────────────────────

    def stats(self) -> dict[str, Any]:
        """Get usage statistics."""
        try:
            resp = self._client.get("/api/memory/stats")
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            pass
        return {}

    def health(self) -> bool:
        """Check TIAMAT API health."""
        try:
            resp = self._client.get("/health")
            return resp.status_code == 200
        except Exception:
            return False

    def close(self) -> None:
        """Close the HTTP client."""
        self._client.close()
