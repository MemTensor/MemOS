from __future__ import annotations

from dataclasses import dataclass


@dataclass
class MemorySearchResult:
    snippets: list[str]


class MemoryAdapter:
    def add_event(self, *, user_id: str, session_id: str, content: str) -> None:
        raise NotImplementedError

    def search(
        self, *, user_id: str, session_id: str, query: str, top_k: int = 5
    ) -> MemorySearchResult:
        raise NotImplementedError


class InMemoryMemoryAdapter(MemoryAdapter):
    def __init__(self):
        self._items: list[tuple[str, str, str]] = []

    def add_event(self, *, user_id: str, session_id: str, content: str) -> None:
        self._items.append((user_id, session_id, content))

    def search(
        self, *, user_id: str, session_id: str, query: str, top_k: int = 5
    ) -> MemorySearchResult:
        snippets: list[str] = []
        for uid, sid, c in reversed(self._items):
            if uid == user_id and sid == session_id:
                snippets.append(c)
            if len(snippets) >= top_k:
                break
        return MemorySearchResult(snippets=list(reversed(snippets)))
