"""Abstract storage interface for project memory.

Ownership rule: a space never changes project. The handler calls ``assert_spaces``
once at the entry point; methods located by ``space_id`` afterwards do not take
``project_id``. Methods located by topic or entry ID take ``project_id`` and verify
ownership through ``spaces``.
"""

from abc import ABC, abstractmethod
from datetime import datetime

from memos.project_dbs.item import (
    AnyEntry,
    Decision,
    Domain,
    DomainUpdate,
    EntryHit,
    Page,
    SearchHit,
    Space,
    SpaceContext,
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
        filter: TopicFilter | None = None,
        page: int = 1,
        size: int = 10,
    ) -> Page[Topic]:
        """Newest update_time first; entries assembled in batch by topic_id."""

    @abstractmethod
    def get_topics(self, project_id: str, topic_ids: list[str]) -> list[Topic]:
        """Locate by topic_id and verify ownership via spaces."""

    @abstractmethod
    def get_entries(self, project_id: str, entry_ids: list[str]) -> list[AnyEntry]:
        """Locate by entry id and verify ownership via spaces."""

    @abstractmethod
    def load_space_context(self, space_id: str, domains: list[str] | None = None) -> SpaceContext:
        """Organizer input: space config, candidate domains and existing topics."""

    # ---------- topic writes ----------
    @abstractmethod
    def apply_changes(self, change_set: TopicChangeSet) -> list[TopicChangeResult]:
        """Write topics and entries in one transaction. Relies on per-space serial execution."""

    @abstractmethod
    def update_topic_decisions(
        self,
        project_id: str,
        topic_id: str,
        expected_update_time: datetime,
        decisions: list[Decision],
    ) -> Topic:
        """Manual edit; UpdateConflictError if update_time differs."""

    @abstractmethod
    def delete_topics(self, project_id: str, topic_ids: list[str]) -> int:
        """Entries cascade with topics. Returns the number of deleted topics."""

    @abstractmethod
    def clear_space(self, space_id: str) -> int:
        """Delete topics and entries, keep space and domains. Returns the count."""

    # ---------- search ----------
    @abstractmethod
    def search_topics(
        self,
        space_ids: list[str],
        query_vec: list[float],
        query_text: str | None = None,
        domains: list[str] | None = None,
        filter: TopicFilter | None = None,
        top_k: int = 20,
    ) -> list[SearchHit]:
        """Space, domain and filter conditions run in the same SQL as recall."""

    @abstractmethod
    def search_entries(
        self,
        space_ids: list[str],
        topic_ids: list[str],
        query_vec: list[float],
        top_k: int = 50,
    ) -> list[EntryHit]:
        """Recall entries within candidate topics; fusion is done by retrieval."""

    # ---------- lifecycle ----------
    def close(self) -> None:  # noqa: B027 - optional hook
        """Release connections and other resources."""
