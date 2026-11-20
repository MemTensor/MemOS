"""Abstract storage interface for project memory.

Ownership is checked by the outer layer (Playground). Storage reads and writes by
space_id, topic id or decision id directly; only the space-level methods
create_space, list_spaces and assert_spaces take project_id.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Literal

from memos.project_dbs.item import (
    AnyEntry,
    Decision,
    Domain,
    DomainUpdate,
    Page,
    SearchHit,
    Space,
    Topic,
    TopicChangeResult,
    TopicChangeSet,
    TopicFilter,
)


MAX_DOMAINS_PER_SPACE = 20


class BaseProjectDB(ABC):
    # ---------- spaces ----------
    @abstractmethod
    def create_space(
        self,
        project_id: str,
        space_name: str,
        instructions: str | None = None,
        domains: list[Domain] | None = None,
    ) -> Space:
        """Create the space and its initial domains in one transaction."""

    @abstractmethod
    def list_spaces(self, project_id: str, space_ids: list[str] | None = None) -> list[Space]:
        """All spaces of the project when space_ids is None, else only the given ones ([] gives []).
        SpaceNotFoundError if any given space is missing or foreign. Newest first."""

    @abstractmethod
    def assert_spaces(
        self, project_id: str, space_ids: list[str], domains: list[str] | None = None
    ) -> list[Space]:
        """Check existence, ownership and domain registration; get/space uses the result directly."""

    @abstractmethod
    def update_space(
        self, space_id: str, space_name: str | None = None, instructions: str | None = None
    ) -> Space:
        """Omitted fields are kept; an empty instructions string clears it.
        ValueError if neither field is given."""

    @abstractmethod
    def delete_space(self, space_id: str) -> None:
        """Delete the space; domains, topics and entries cascade. Idempotent."""

    # ---------- domains ----------
    @abstractmethod
    def create_domains(self, space_id: str, domains: list[Domain]) -> list[Domain]:
        """Register in batch; existing names are skipped and keep their values. Returns only
        the newly registered domains. DomainLimitExceededError if the space would exceed the cap."""

    @abstractmethod
    def update_domains(self, space_id: str, updates: list[DomainUpdate]) -> list[Domain]:
        """Apply in order, locating each by its current name; returns the updated rows.
        DomainNotFoundError (also for a missing space) / DomainAlreadyExistsError roll back
        the whole batch."""

    @abstractmethod
    def delete_domains(self, space_id: str, names: list[str]) -> list[Domain]:
        """Missing names (or a missing space) are ignored; returns the deleted rows.
        DomainInUseError rejects the whole batch if any domain is used by a topic."""

    @abstractmethod
    def list_domains(self, space_id: str) -> list[Domain]:
        """Full list, not paginated. Earlier batches come first; order within one batch is
        unspecified. A missing space gives []."""

    # ---------- topic and entry reads ----------
    @abstractmethod
    def list_topics(
        self,
        space_id: str,
        filters: list[TopicFilter] | None = None,
        page: int = 1,
        size: int = 10,
        preview_size: int = 5,
    ) -> Page[Topic]:
        """get/memory by space_id. Topics newest update_time first; each topic carries at
        most preview_size entries per type (newest time first) without history/conflicts.
        Filter groups are ORed, conditions inside a group ANDed; None or [] means no filter."""

    @abstractmethod
    def list_entries(
        self,
        topic_id: str,
        entry_type: Literal["decision", "experience", "timeline"],
        page: int = 1,
        size: int = 10,
    ) -> Page[AnyEntry]:
        """get/memory by topic_id. Entries of one type, newest time first, with full
        history/conflicts."""

    @abstractmethod
    def get_topics_detail(self, topic_ids: list[str]) -> list[Topic]:
        """Full topics with all entries, for organizing and retrieval. Unknown ids are skipped."""

    # ---------- topic writes ----------
    @abstractmethod
    def apply_changes(self, change_set: TopicChangeSet) -> list[TopicChangeResult]:
        """Write creates and updates in one transaction; any failure rolls back the batch:
        SpaceNotFoundError, SpaceClearedError (accepted_at <= cleared_at), VersionConflictError,
        DomainNotFoundError (unregistered domain), TopicNotFoundError (unknown topic),
        EntryNotFoundError (upserted entry id not in the topic).
        Entry upserts by id replace the whole entry, including embedding (None clears it)."""

    @abstractmethod
    def update_decision(
        self,
        decision_id: str,
        expected_update_time: datetime,
        content: str,
        embedding: list[float] | None = None,
    ) -> Decision:
        """update/memory. Replace content and embedding (None clears it), clear conflicts,
        bump the entry version, all in one UPDATE; the parent topic is left unchanged.
        UpdateConflictError if update_time differs (exact, microsecond precision) or the id
        is not a decision. expected_update_time must be timezone-aware."""

    @abstractmethod
    def delete_topics(self, topic_ids: list[str]) -> int:
        """Entries cascade with topics. Returns the number of deleted topics."""

    @abstractmethod
    def clear_space(self, space_id: str) -> int:
        """Delete topics and entries and record cleared_at; keep space and domains.
        Returns the number of deleted topics."""

    # ---------- search ----------
    @abstractmethod
    def search_topics_by_embedding(
        self,
        space_ids: list[str],
        query_vec: list[float],
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
    ) -> list[SearchHit]:
        """Recall topic headers by cosine similarity within the supplied filters."""

    @abstractmethod
    def search_topics_by_fulltext(
        self,
        space_ids: list[str],
        query_text: str,
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
    ) -> list[SearchHit]:
        """Recall topic headers by database full-text rank within the supplied filters."""

    # ---------- lifecycle ----------
    def close(self) -> None:  # noqa: B027 - optional hook
        """Release connections and other resources."""
