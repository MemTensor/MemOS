"""Abstract storage interface for project memory.

Ownership is checked by the outer layer (Playground): storage reads and writes by space_id,
topic id or entry id directly; only the space-level methods create_space, list_spaces and
assert_spaces take project_id.

Filter parameters mean the same everywhere:
  filters  list[TopicFilter]; groups are ORed, conditions inside a group ANDed; None or []
           means no filter. Only create_time and update_time exist this phase.
  domains  domain names; None means no filter.
messages, episodes and add_jobs are read and written by the Add plugin's storage, not here.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Literal

from memos.project_dbs.item import (
    AnyEntry,
    Decision,
    Domain,
    DomainUpdate,
    EntryHit,
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
        """Delete the space; domains, topics, entries and Episodes cascade. Idempotent."""

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
        """get/memory by space_id. Topics by importance (extra.rank_time, see ranking.py)
        newest first, then update_time newest first, then id. Each topic carries at most
        preview_size ACTIVE entries per type, without history/conflicts: decisions with open
        conflicts first, then more user_ids, then newest chat_time; experiences verified
        first, then higher confidence, then newest chat_time; timeline the newest
        preview_size, returned oldest first."""

    @abstractmethod
    def list_entries(
        self,
        topic_id: str,
        entry_type: Literal["decision", "experience", "timeline"],
        filters: list[TopicFilter] | None = None,
        page: int = 1,
        size: int = 10,
    ) -> Page[AnyEntry]:
        """get/memory by topic_id. ACTIVE entries of one type in the list_topics preview
        order (timeline oldest first), paginated; decisions carry their full history and
        conflicts. Filter ranges (create_time and update_time alike) compare the entry
        chat_time."""

    @abstractmethod
    def get_topics_detail(self, topic_ids: list[str], with_entries: bool = True) -> list[Topic]:
        """Full topics with all ACTIVE entries (decisions with history/conflicts), for
        organizing and retrieval, in the given order. Unknown ids are skipped.
        with_entries=False returns the topic headers only."""

    @abstractmethod
    def get_entry(self, entry_id: str) -> AnyEntry | None:
        """get/memory/{id}: one entry with topic_id and space_id; a decision child-row id
        returns its decision. None when the id does not exist."""

    # ---------- topic writes ----------
    @abstractmethod
    def apply_changes(self, change_set: TopicChangeSet) -> list[TopicChangeResult]:
        """Write creates and updates in one transaction; any failure rolls back the batch:
        SpaceNotFoundError, SpaceClearedError (accept_time <= clear_time), VersionConflictError,
        DomainNotFoundError (unregistered domain), TopicNotFoundError (unknown topic),
        EntryNotFoundError (upserted entry or child id not found).
        Writing sources recomputes conversation_ids, writing anchors recomputes anchor_keys,
        in the same statement. Decision history becomes ARCHIVED child rows (append-only;
        items with an id are kept untouched), conflicts replace the CONFLICT child rows
        (items with an id keep it). An entry upserted by id is replaced whole; a missing
        embedding clears the stored vector. Results: creates (ADD) then updates (UPDATE)."""

    @abstractmethod
    def update_decision(
        self,
        decision_id: str,
        expected_update_time: datetime,
        content: str,
        embedding: list[float] | None = None,
    ) -> Decision:
        """update/memory. Replace content and embedding (None clears it), delete the
        CONFLICT child rows and bump the entry version, in one transaction; the topic
        version is unchanged. UpdateConflictError if update_time differs (exact, microsecond
        precision) or the id is not an ACTIVE decision. expected_update_time must be
        timezone-aware."""

    @abstractmethod
    def delete_topics(self, topic_ids: list[str]) -> int:
        """Entries cascade with topics; Episodes filed under them get topic_id NULL.
        Returns the number of deleted topics."""

    @abstractmethod
    def clear_space(self, space_id: str) -> int:
        """Delete topics and entries and record clear_time; keep space and domains.
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
        """Recall topic headers matching any query term, best match first."""

    @abstractmethod
    def search_entries_by_embedding(
        self,
        space_ids: list[str],
        query_vec: list[float],
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
        per_topic: int = 6,
    ) -> list[EntryHit]:
        """Recall entries across the spaces, not limited to recalled topics. Decision child
        rows count for their decision (best score kept); retired experiences are skipped.
        Returns the entries of the top_k best topics, at most per_topic each, best first.
        filters apply to the topic times."""

    @abstractmethod
    def search_entries_by_fulltext(
        self,
        space_ids: list[str],
        query_text: str,
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
        per_topic: int = 6,
    ) -> list[EntryHit]:
        """Same as search_entries_by_embedding, matching any query term by full-text rank."""

    # ---------- lifecycle ----------
    def close(self) -> None:  # noqa: B027 - optional hook
        """Release connections and other resources."""
