"""In-memory BaseProjectDB for algorithm and API unit tests. Not for production."""

import copy
import json
import threading
import uuid

from datetime import datetime, timedelta, timezone

from memos.project_dbs.base import MAX_DOMAINS_PER_SPACE, BaseProjectDB
from memos.project_dbs.exceptions import (
    DomainAlreadyExistsError,
    DomainInUseError,
    DomainLimitExceededError,
    DomainNotFoundError,
    EntryNotFoundError,
    SpaceClearedError,
    SpaceNotFoundError,
    TopicNotFoundError,
    UpdateConflictError,
    VersionConflictError,
)
from memos.project_dbs.item import (
    Domain,
    DomainUpdate,
    Page,
    Space,
    Topic,
    TopicChangeResult,
)


_last = datetime.min.replace(tzinfo=timezone.utc)


_FIELDS = {"decision": "decisions", "experience": "experiences", "timeline": "timeline"}


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
        self._topics: dict[str, dict] = {}  # topic_id -> stored topic fields
        self._entries: dict[str, dict] = {}  # entry_id -> {"topic_id", "entry": AnyEntry}

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
            self._drop_topics([k for k, v in self._topics.items() if v["space_id"] == space_id])

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

    # ---------- topics and entries ----------

    def _drop_topics(self, topic_ids: list[str]) -> int:
        dropped = [t for t in topic_ids if self._topics.pop(t, None) is not None]
        gone = set(dropped)
        self._entries = {k: v for k, v in self._entries.items() if v["topic_id"] not in gone}
        return len(dropped)

    def _topic(self, topic_id: str, preview_size: int | None) -> Topic:
        stored = self._topics[topic_id]
        domain = next(
            d.domain for d in self._domains[stored["space_id"]] if d.id == stored["domain_id"]
        )
        topic = Topic(
            id=topic_id,
            domain=domain,
            **{k: v for k, v in stored.items() if k not in ("domain_id", "embedding")},
        )
        entries = sorted(
            (v["entry"] for v in self._entries.values() if v["topic_id"] == topic_id),
            key=lambda e: (-e.time.timestamp(), e.id),
        )
        for entry_type, field in _FIELDS.items():
            items = [e.model_copy(deep=True) for e in entries if e.entry_type == entry_type]
            if preview_size is not None:
                items = items[:preview_size]
                if entry_type == "decision":
                    for item in items:
                        item.history, item.conflicts = [], []
            setattr(topic, field, items)
        return topic

    @staticmethod
    def _matches(stored: dict, filters) -> bool:
        if not filters:
            return True
        ops = {
            "gt": lambda a, b: a > b,
            "gte": lambda a, b: a >= b,
            "lt": lambda a, b: a < b,
            "lte": lambda a, b: a <= b,
        }
        for group in filters:
            ok = True
            for column in ("create_time", "update_time"):
                time_range = getattr(group, column)
                if time_range is None:
                    continue
                for op, check in ops.items():
                    value = getattr(time_range, op)
                    if value is not None and not check(stored[column], value):
                        ok = False
            if ok:
                return True
        return False

    def list_topics(self, space_id, filters=None, page=1, size=10, preview_size=5):
        with self._lock:
            ids = [
                k
                for k, v in self._topics.items()
                if v["space_id"] == space_id and self._matches(v, filters)
            ]
            ids.sort()
            ids.sort(key=lambda k: self._topics[k]["update_time"], reverse=True)
            chosen = ids[(page - 1) * size : page * size]
            items = [self._topic(k, preview_size) for k in chosen]
            return Page[Topic](items=items, total=len(ids), page=page, size=size)

    def list_entries(self, topic_id, entry_type, page=1, size=10):
        with self._lock:
            entries = sorted(
                (
                    v["entry"]
                    for v in self._entries.values()
                    if v["topic_id"] == topic_id and v["entry"].entry_type == entry_type
                ),
                key=lambda e: (-e.time.timestamp(), e.id),
            )
            chosen = [e.model_copy(deep=True) for e in entries[(page - 1) * size : page * size]]
            return Page(items=chosen, total=len(entries), page=page, size=size)

    def get_topics_detail(self, topic_ids):
        with self._lock:
            return [self._topic(k, None) for k in dict.fromkeys(topic_ids) if k in self._topics]

    @staticmethod
    def _dedupe(existing: list[dict], sources) -> list[dict]:
        result = list(existing)
        seen = {json.dumps(s, sort_keys=True) for s in result}
        for source in sources:
            item = source.model_dump(mode="json")
            key = json.dumps(item, sort_keys=True)
            if key not in seen:
                seen.add(key)
                result.append(item)
        return result

    @staticmethod
    def _stored_entry(entry, entry_id: str, now, version: int = 1, create_time=None):
        stored = entry.model_copy(deep=True)
        stored.id = entry_id
        stored.version = version
        stored.create_time = create_time or now
        stored.update_time = now
        stored.embedding = None
        return stored

    def apply_changes(self, change_set):
        with self._lock:
            space = self._require_space(change_set.space_id)
            if space.cleared_at is not None and change_set.accepted_at <= space.cleared_at:
                raise SpaceClearedError(f"Space {space.id} was cleared after the task was accepted")
            domain_ids = {d.domain: d.id for d in self._domains[space.id]}

            def resolve(name):
                if name not in domain_ids:
                    raise DomainNotFoundError(f"Domain not registered: {name}")
                return domain_ids[name]

            topics, entries = copy.deepcopy(self._topics), copy.deepcopy(self._entries)
            now = _now()
            results = []
            for item in change_set.creates:
                topic_id = f"topic_{uuid.uuid4().hex}"
                topics[topic_id] = {
                    "space_id": space.id,
                    "domain_id": resolve(item.domain),
                    "topic_name": item.topic_name,
                    "topic_summary": item.topic_summary,
                    "topic_description": item.topic_description,
                    "sources": self._dedupe([], item.sources),
                    "create_time": now,
                    "update_time": now,
                    "version": 1,
                    "anchors": copy.deepcopy(item.anchors),
                    "anchor_keys": [],
                }
                for entry in item.entries:
                    entry_id = str(uuid.uuid4())
                    entries[entry_id] = {
                        "topic_id": topic_id,
                        "entry": self._stored_entry(entry, entry_id, now),
                    }
                results.append(TopicChangeResult(topic_id=topic_id, operation="ADD"))
            for item in change_set.updates:
                stored = topics.get(item.topic_id)
                if stored is None or stored["space_id"] != space.id:
                    raise TopicNotFoundError(f"Topic not found: {item.topic_id}")
                if stored["version"] != item.expected_version:
                    raise VersionConflictError(f"Topic {item.topic_id} changed")
                if item.domain is not None:
                    stored["domain_id"] = resolve(item.domain)
                for field in ("topic_summary", "topic_description"):
                    if getattr(item, field) is not None:
                        stored[field] = getattr(item, field)
                if item.anchors is not None:
                    stored["anchors"] = copy.deepcopy(item.anchors)
                stored["sources"] = self._dedupe(stored["sources"], item.add_sources)
                stored["version"] += 1
                stored["update_time"] = now
                for entry_id in item.delete_entry_ids:
                    if entries.get(entry_id, {}).get("topic_id") == item.topic_id:
                        del entries[entry_id]
                for entry in item.upsert_entries:
                    if entry.id is None:
                        entry_id = str(uuid.uuid4())
                        entries[entry_id] = {
                            "topic_id": item.topic_id,
                            "entry": self._stored_entry(entry, entry_id, now),
                        }
                        continue
                    old = entries.get(entry.id)
                    if old is None or old["topic_id"] != item.topic_id:
                        raise EntryNotFoundError(f"Entry not found: {entry.id}")
                    old["entry"] = self._stored_entry(
                        entry,
                        entry.id,
                        now,
                        version=old["entry"].version + 1,
                        create_time=old["entry"].create_time,
                    )
                results.append(TopicChangeResult(topic_id=item.topic_id, operation="UPDATE"))
            self._topics, self._entries = topics, entries
            return results

    def update_decision(self, decision_id, expected_update_time, content, embedding=None):
        if expected_update_time.tzinfo is None:
            raise ValueError("expected_update_time must be timezone-aware")
        with self._lock:
            stored = self._entries.get(decision_id)
            entry = stored["entry"] if stored else None
            if (
                entry is None
                or entry.entry_type != "decision"
                or entry.update_time != expected_update_time
            ):
                raise UpdateConflictError(f"Decision {decision_id} changed")
            entry.content = content
            entry.conflicts = []
            entry.version += 1
            entry.update_time = _now()
            return entry.model_copy(deep=True)

    def delete_topics(self, topic_ids):
        with self._lock:
            return self._drop_topics(list(topic_ids))

    def clear_space(self, space_id):
        with self._lock:
            space = self._require_space(space_id)
            space.cleared_at = _now()
            return self._drop_topics(
                [k for k, v in self._topics.items() if v["space_id"] == space_id]
            )

    # ---------- search: not implemented yet ----------
    def search_topics_by_embedding(
        self, space_ids, query_vec, domains=None, filters=None, top_k=20
    ):
        raise NotImplementedError

    def search_topics_by_fulltext(
        self, space_ids, query_text, domains=None, filters=None, top_k=20
    ):
        raise NotImplementedError
