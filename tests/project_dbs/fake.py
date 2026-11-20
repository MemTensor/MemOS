"""In-memory BaseProjectDB for algorithm and API unit tests. Not for production."""

import threading
import uuid

from datetime import datetime, timedelta, timezone

from memos.project_dbs.base import MAX_DOMAINS_PER_SPACE, BaseProjectDB
from memos.project_dbs.exceptions import (
    DomainAlreadyExistsError,
    DomainInUseError,
    DomainLimitExceededError,
    DomainNotFoundError,
    SpaceNotFoundError,
)
from memos.project_dbs.item import Domain, DomainUpdate, Space


_last = datetime.min.replace(tzinfo=timezone.utc)


def _now() -> datetime:
    """Strictly increasing, so ordering never depends on clock resolution."""
    global _last
    _last = max(datetime.now(timezone.utc), _last + timedelta(microseconds=1))
    return _last


class FakeProjectDB(BaseProjectDB):
    def __init__(self):
        self._lock = threading.RLock()
        self._spaces: dict[str, Space] = {}
        self._domains: dict[str, list[Domain]] = {}  # space_id -> domains in registration order
        self._topics: dict[str, dict] = {}  # topic_id -> {"space_id", "domain_id", ...}

    # ---------- spaces ----------
    def _require_space(self, space_id: str) -> Space:
        if space_id not in self._spaces:
            raise SpaceNotFoundError(f"Space not found: {space_id}")
        return self._spaces[space_id]

    def _add_domains(self, space_id: str, domains: list[Domain]) -> list[Domain]:
        merged = list(self._domains[space_id])
        for item in domains:
            if all(d.domain != item.domain for d in merged):
                new = Domain(
                    id=str(uuid.uuid4()),
                    space_id=space_id,
                    domain=item.domain,
                    description=item.description,
                )
                merged.append(new)
        if len(merged) > MAX_DOMAINS_PER_SPACE:
            raise DomainLimitExceededError(
                f"Space {space_id} would exceed {MAX_DOMAINS_PER_SPACE} domains"
            )
        return merged

    def create_space(self, project_id, space_name, instructions=None, domains=None) -> Space:
        with self._lock:
            now = _now()
            space = Space(
                id=str(uuid.uuid4()),
                project_id=project_id,
                space_name=space_name,
                instructions=instructions or None,
                create_time=now,
                update_time=now,
            )
            self._domains[space.id] = []
            try:
                merged = self._add_domains(space.id, domains or [])
            except DomainLimitExceededError:
                del self._domains[space.id]
                raise
            self._spaces[space.id] = space
            self._domains[space.id] = merged
            return space.model_copy()

    def list_spaces(self, project_id, space_ids=None) -> list[Space]:
        with self._lock:
            spaces = [
                s
                for s in self._spaces.values()
                if s.project_id == project_id and (space_ids is None or s.id in space_ids)
            ]
            missing = set(space_ids or []) - {s.id for s in spaces}
            if missing:
                raise SpaceNotFoundError(f"Space not found: {sorted(missing)}")
            spaces.sort(key=lambda s: s.id)
            spaces.sort(key=lambda s: s.create_time, reverse=True)
            return [s.model_copy() for s in spaces]

    def assert_spaces(self, project_id, space_ids, domains=None) -> list[Space]:
        with self._lock:
            ordered = list(dict.fromkeys(space_ids))
            if not ordered:
                return []
            found = {s.id: s for s in self.list_spaces(project_id, ordered)}
            missing = [
                (s, d)
                for s in ordered
                for d in domains or []
                if all(x.domain != d for x in self._domains[s])
            ]
            if missing:
                raise DomainNotFoundError(f"Domain not registered (space, domain): {missing}")
            return [found[s] for s in ordered]

    def update_space(self, space_id, space_name=None, instructions=None) -> Space:
        if space_name is None and instructions is None:
            raise ValueError("update_space needs space_name or instructions")
        with self._lock:
            space = self._require_space(space_id)
            if space_name is not None:
                space.space_name = space_name
            if instructions is not None:
                space.instructions = instructions or None
            space.update_time = _now()
            return space.model_copy()

    def delete_space(self, space_id) -> None:
        with self._lock:
            self._spaces.pop(space_id, None)
            self._domains.pop(space_id, None)
            self._topics = {k: v for k, v in self._topics.items() if v["space_id"] != space_id}

    # ---------- domains ----------
    def create_domains(self, space_id, domains) -> list[Domain]:
        with self._lock:
            self._require_space(space_id)
            before = {d.id for d in self._domains[space_id]}
            self._domains[space_id] = self._add_domains(space_id, domains)
            return [d.model_copy() for d in self._domains[space_id] if d.id not in before]

    def update_domains(self, space_id, updates: list[DomainUpdate]) -> list[Domain]:
        with self._lock:
            working = [d.model_copy() for d in self._domains.get(space_id, [])]
            updated: dict[str, Domain] = {}
            for item in updates:
                current = next((d for d in working if d.domain == item.domain), None)
                if current is None:
                    raise DomainNotFoundError(
                        f"Domain not found in space {space_id}: {item.domain}"
                    )
                if item.new_domain is not None:
                    if any(d.domain == item.new_domain and d is not current for d in working):
                        raise DomainAlreadyExistsError(
                            f"Domain already exists in space {space_id}: {item.new_domain}"
                        )
                    current.domain = item.new_domain
                if item.description is not None:
                    current.description = item.description
                updated[current.id] = current
            if space_id in self._domains:
                self._domains[space_id] = working
            return [d.model_copy() for d in updated.values()]

    def delete_domains(self, space_id, names) -> list[Domain]:
        with self._lock:
            domains = self._domains.get(space_id, [])
            deleted = [d for d in domains if d.domain in names]
            used = {t["domain_id"] for t in self._topics.values() if t["space_id"] == space_id}
            if any(d.id in used for d in deleted):
                raise DomainInUseError(f"Domain still referenced by topics in space {space_id}")
            if space_id in self._domains:
                self._domains[space_id] = [d for d in domains if d not in deleted]
            return [d.model_copy() for d in deleted]

    def list_domains(self, space_id) -> list[Domain]:
        with self._lock:
            return [d.model_copy() for d in self._domains.get(space_id, [])]

    # ---------- topics, entries, search: not implemented yet ----------
    def list_topics(self, space_id, filter=None, page=1, size=10):
        raise NotImplementedError

    def get_topics(self, project_id, topic_ids):
        raise NotImplementedError

    def get_entries(self, project_id, entry_ids):
        raise NotImplementedError

    def load_space_context(self, space_id, domains=None):
        raise NotImplementedError

    def apply_changes(self, change_set):
        raise NotImplementedError

    def update_topic_decisions(self, project_id, topic_id, expected_update_time, decisions):
        raise NotImplementedError

    def delete_topics(self, project_id, topic_ids):
        raise NotImplementedError

    def clear_space(self, space_id):
        raise NotImplementedError

    def search_topics(
        self, space_ids, query_vec, query_text=None, domains=None, filter=None, top_k=20
    ):
        raise NotImplementedError

    def search_entries(self, space_ids, topic_ids, query_vec, top_k=50):
        raise NotImplementedError
