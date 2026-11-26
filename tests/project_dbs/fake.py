"""In-memory BaseProjectDB for algorithm and API unit tests. Not for production.

Stores rows the way PostgreSQL does (decision child rows with status / parent_decision_id) and
shares the writer's derivation helpers and the ranking formula. Search is not implemented.
"""

import copy
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
    ConflictCard,
    DecisionCard,
    Domain,
    DomainUpdate,
    EntryStatus,
    Page,
    Space,
    Topic,
    TopicChangeResult,
)
from memos.project_dbs.postgres_rows import ENTRY_TYPES, TOPIC_FIELDS
from memos.project_dbs.postgres_writer import (
    anchor_keys,
    conversation_ids,
    entry_status,
    experience_content,
    merge_sources,
)
from memos.project_dbs.ranking import RankSignals, rank_time


ACTIVE, ARCHIVED, CONFLICT = (int(s) for s in EntryStatus)
_CARD_COLUMNS = {"id", "content", "chat_time", "user_ids", "embedding"}
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
        self._topics: dict[str, dict] = {}  # topic_id -> topics row
        self._rows: dict[str, dict] = {}  # entry id -> project_entries row

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
                current = next((d for d in working if d.id == item.domain_id), None)
                if current is None:
                    raise DomainNotFoundError(
                        f"Domain not found in space {space_id}: {item.domain_id}"
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

    def delete_domains(self, space_id, domain_ids) -> list[Domain]:
        with self._lock:
            domains = self._domains.get(space_id, [])
            deleted = [d for d in domains if d.id in domain_ids]
            used = {t["domain_id"] for t in self._topics.values() if t["space_id"] == space_id}
            if any(d.id in used for d in deleted):
                raise DomainInUseError(f"Domain still referenced by topics in space {space_id}")
            if space_id in self._domains:
                self._domains[space_id] = [d for d in domains if d not in deleted]
            return [d.model_copy() for d in deleted]

    def list_domains(self, space_id) -> list[Domain]:
        with self._lock:
            return [d.model_copy() for d in self._domains.get(space_id, [])]

    # ---------- row assembly ----------
    def _drop_topics(self, topic_ids: list[str]) -> int:
        dropped = [t for t in topic_ids if self._topics.pop(t, None) is not None]
        gone = set(dropped)
        self._rows = {k: v for k, v in self._rows.items() if v["topic_id"] not in gone}
        return len(dropped)

    def _children(self, decision_id: str) -> tuple[list, list]:
        rows = sorted(
            (r for r in self._rows.values() if r["parent_decision_id"] == decision_id),
            key=lambda r: (r["chat_time"], r["id"]),
        )
        cards = [
            ({"id": r["id"], "content": r["content"], "chat_time": r["chat_time"],
              "user_ids": list(r["user_ids"]), **copy.deepcopy(r["extra"])}, r["status"])
            for r in rows
        ]  # fmt: skip
        history = [DecisionCard.model_validate(c) for c, s in cards if s == ARCHIVED]
        conflicts = [ConflictCard.model_validate(c) for c, s in cards if s == CONFLICT]
        return history, conflicts

    def _entry(self, row: dict, with_children: bool = True):
        data = {k: copy.deepcopy(v) for k, v in row.items() if k != "parent_decision_id"}
        entry_type = data.pop("entry_type")
        if entry_type == "decision" and with_children:
            data["history"], data["conflicts"] = self._children(row["id"])
        return ENTRY_TYPES[entry_type].model_validate(data)

    def _has_conflict(self, decision_id: str) -> bool:
        return any(
            r["parent_decision_id"] == decision_id and r["status"] == CONFLICT
            for r in self._rows.values()
        )

    def _pick_key(self, row: dict):
        """PREVIEW_ORDER of the PostgreSQL backend."""
        if row["entry_type"] == "decision":
            k1, k2 = int(self._has_conflict(row["id"])), len(row["user_ids"])
        elif row["entry_type"] == "experience":
            k1 = int(row["extra"].get("exp_status") == "verified")
            k2 = row["extra"].get("confidence") or 0
        else:
            k1 = k2 = 0
        return (-k1, -k2, -row["chat_time"].timestamp(), row["id"])

    def _ordered(self, rows: list[dict], entry_type: str, limit: int | None = None) -> list[dict]:
        """Display order; with a limit, the first `limit` by preview order."""
        rows = sorted(rows, key=self._pick_key)[:limit]
        if entry_type == "timeline":
            rows.sort(key=lambda r: (r["chat_time"], r["id"]))
        return rows

    def _active(self, topic_id: str, entry_type: str) -> list[dict]:
        return [
            r
            for r in self._rows.values()
            if r["topic_id"] == topic_id and r["entry_type"] == entry_type and r["status"] == ACTIVE
        ]

    def _topic(self, topic_id: str, preview_size: int | None, with_entries: bool = True) -> Topic:
        stored = self._topics[topic_id]
        domain = next(
            d.domain for d in self._domains[stored["space_id"]] if d.id == stored["domain_id"]
        )
        topic = Topic(
            id=topic_id,
            domain=domain,
            **{k: copy.deepcopy(stored[k]) for k in (
                "space_id", "topic_name", "topic_summary", "topic_description", "sources",
                "create_time", "update_time", "version", "anchors")},
        )  # fmt: skip
        if with_entries:
            for entry_type, field in TOPIC_FIELDS.items():
                rows = self._ordered(self._active(topic_id, entry_type), entry_type, preview_size)
                setattr(topic, field, [self._entry(r, preview_size is None) for r in rows])
        return topic

    @staticmethod
    def _matches(values: dict, filters) -> bool:
        """values maps create_time / update_time to the compared time."""
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
                    if value is not None and not check(values[column], value):
                        ok = False
            if ok:
                return True
        return False

    # ---------- reads ----------
    def list_topics(self, space_id, filters=None, page=1, size=10, preview_size=5):
        with self._lock:
            ids = [
                k
                for k, v in self._topics.items()
                if v["space_id"] == space_id and self._matches(v, filters)
            ]
            ids.sort()
            ids.sort(key=lambda k: self._topics[k]["update_time"], reverse=True)
            ids.sort(key=lambda k: self._topics[k]["extra"].get("rank_time") is None)
            ids.sort(  # rank_time DESC NULLS LAST, stable on ties
                key=lambda k: datetime.fromisoformat(
                    self._topics[k]["extra"].get("rank_time") or "0001-01-01T00:00:00+00:00"
                ),
                reverse=True,
            )
            chosen = ids[(page - 1) * size : page * size]
            items = [self._topic(k, max(preview_size, 0)) for k in chosen]
            return Page[Topic](items=items, total=len(ids), page=page, size=size)

    def list_entries(self, topic_id, entry_type, filters=None, page=1, size=10):
        with self._lock:
            rows = [
                r
                for r in self._active(topic_id, entry_type)
                if self._matches({"create_time": r["chat_time"], "update_time": r["chat_time"]},
                                 filters)
            ]  # fmt: skip
            rows = self._ordered(rows, entry_type)
            chosen = [self._entry(r) for r in rows[(page - 1) * size : page * size]]
            return Page(items=chosen, total=len(rows), page=page, size=size)

    def get_topics_detail(self, topic_ids, with_entries=True):
        with self._lock:
            return [
                self._topic(k, None, with_entries)
                for k in dict.fromkeys(topic_ids)
                if k in self._topics
            ]

    def get_entry(self, entry_id):
        with self._lock:
            row = self._rows.get(entry_id)
            if row is None:
                return None
            return self._entry(self._rows[row["parent_decision_id"] or entry_id])

    # ---------- writes ----------
    @staticmethod
    def _row(space_id, topic_id, entry_type, status, parent, card, extra, now) -> dict:
        return {
            "id": str(uuid.uuid4()),
            "topic_id": topic_id,
            "space_id": space_id,
            "entry_type": entry_type,
            "status": status,
            "parent_decision_id": parent,
            "content": card.content,
            "chat_time": card.chat_time,
            "user_ids": list(card.user_ids),
            "extra": extra,
            "version": 1,
            "create_time": now,
            "update_time": now,
        }

    @staticmethod
    def _card_extra(card) -> dict:
        return card.model_dump(mode="json", exclude=_CARD_COLUMNS, exclude_none=True)

    def _add_child(self, rows, space_id, topic_id, decision_id, status, card, now) -> None:
        row = self._row(
            space_id, topic_id, "decision", status, decision_id, card, self._card_extra(card), now
        )
        rows[row["id"]] = row

    def _insert(self, rows: dict, space_id, topic_id, entry, now) -> None:
        extra = entry.extra.model_dump(mode="json")
        status = entry_status(entry)
        row = self._row(space_id, topic_id, entry.entry_type, status, None, entry, extra, now)
        if entry.entry_type == "experience":
            row["content"] = experience_content(entry.extra.card)
        rows[row["id"]] = row
        if entry.entry_type == "decision":
            for status, cards in ((ARCHIVED, entry.history), (CONFLICT, entry.conflicts)):
                for card in cards:
                    if card.id is not None:
                        raise EntryNotFoundError(f"Child row not found: {card.id}")
                    self._add_child(rows, space_id, topic_id, row["id"], status, card, now)

    def _overwrite(self, rows: dict, space_id, topic_id, entry, now) -> None:
        old = rows.get(entry.id)
        if (
            old is None
            or old["topic_id"] != topic_id
            or old["parent_decision_id"] is not None
            or old["status"]
            not in ((ACTIVE, ARCHIVED) if entry.entry_type == "experience" else (ACTIVE,))
            or old["entry_type"] != entry.entry_type
        ):
            raise EntryNotFoundError(f"Active entry not found in topic {topic_id}: {entry.id}")
        old.update(
            content=experience_content(entry.extra.card)
            if entry.entry_type == "experience"
            else entry.content,
            chat_time=entry.chat_time,
            user_ids=list(entry.user_ids),
            extra=entry.extra.model_dump(mode="json"),
            status=entry_status(entry),
            version=old["version"] + 1,
            update_time=now,
        )
        if entry.entry_type != "decision":
            return
        children = {r["id"]: r for r in rows.values() if r["parent_decision_id"] == entry.id}
        for card in entry.history:
            if card.id is None:
                self._add_child(rows, space_id, topic_id, entry.id, ARCHIVED, card, now)
            elif children.get(card.id, {}).get("status") != ARCHIVED:
                raise EntryNotFoundError(f"History row not found: {card.id}")
        kept = {c.id for c in entry.conflicts if c.id is not None}
        for card in entry.conflicts:
            if card.id is None:
                self._add_child(rows, space_id, topic_id, entry.id, CONFLICT, card, now)
                continue
            child = children.get(card.id)
            if child is None or child["status"] != CONFLICT:
                raise EntryNotFoundError(f"Conflict row not found: {card.id}")
            child.update(
                content=card.content,
                chat_time=card.chat_time,
                user_ids=list(card.user_ids),
                extra=self._card_extra(card),
                version=child["version"] + 1,
                update_time=now,
            )
        for child_id, child in children.items():
            if child["status"] == CONFLICT and child_id not in kept:
                del rows[child_id]

    def _refresh_rank(self, topics: dict, rows: dict, topic_id: str) -> None:
        topic = topics[topic_id]
        mine = [r for r in rows.values() if r["topic_id"] == topic_id]
        active = [r for r in mine if r["status"] == ACTIVE]
        members = {u for r in active for u in r["user_ids"]}
        members |= {u for s in topic["sources"] for u in s.get("user_id") or []}
        signals = RankSignals(
            open_conflicts=sum(r["status"] == CONFLICT for r in mine),
            active_decisions=sum(r["entry_type"] == "decision" for r in active),
            verified_experiences=sum(
                r["entry_type"] == "experience" and r["extra"].get("exp_status") == "verified"
                for r in active
            ),
            members=len(members - {""}),
            conversations=len(topic["conversation_ids"]),
        )
        key, bonus = rank_time(topic["update_time"], signals)
        topic["extra"]["rank_time"] = key.astimezone(timezone.utc).isoformat()
        topic["extra"]["rank"] = bonus

    def apply_changes(self, change_set):
        with self._lock:
            space = self._require_space(change_set.space_id)
            if space.clear_time is not None and change_set.accept_time <= space.clear_time:
                raise SpaceClearedError(f"Space {space.id} was cleared after the task was accepted")
            domain_ids = {d.domain: d.id for d in self._domains[space.id]}

            def resolve(name):
                if name not in domain_ids:
                    raise DomainNotFoundError(f"Domain not registered: {name}")
                return domain_ids[name]

            topics, rows = copy.deepcopy(self._topics), copy.deepcopy(self._rows)
            now = _now()
            results = []
            for item in change_set.creates:
                topic_id = f"topic_{uuid.uuid4().hex}"
                sources = merge_sources([], item.sources)
                anchors = [a.model_dump(mode="json") for a in item.anchors]
                topics[topic_id] = {
                    "space_id": space.id,
                    "domain_id": resolve(item.domain),
                    "topic_name": item.topic_name,
                    "topic_summary": item.topic_summary,
                    "topic_description": item.topic_description,
                    "sources": sources,
                    "conversation_ids": conversation_ids(sources),
                    "create_time": item.create_time,
                    "update_time": item.update_time,
                    "commit_time": now,
                    "version": 1,
                    "anchors": anchors,
                    "anchor_keys": anchor_keys(anchors),
                    "extra": {},
                }
                for entry in item.entries:
                    self._insert(rows, space.id, topic_id, entry, now)
                results.append(TopicChangeResult(topic_id=topic_id, operation="ADD"))
            for item in change_set.updates:
                stored = topics.get(item.topic_id)
                if stored is None or stored["space_id"] != space.id:
                    raise TopicNotFoundError(f"Topic not found: {item.topic_id}")
                if stored["version"] != item.expected_version:
                    raise VersionConflictError(f"Topic {item.topic_id} changed")
                if item.domain is not None:
                    stored["domain_id"] = resolve(item.domain)
                for field in ("topic_summary", "topic_description", "update_time"):
                    if getattr(item, field) is not None:
                        stored[field] = getattr(item, field)
                if item.anchors is not None:
                    stored["anchors"] = [a.model_dump(mode="json") for a in item.anchors]
                    stored["anchor_keys"] = anchor_keys(stored["anchors"])
                stored["sources"] = merge_sources(stored["sources"], item.add_sources)
                stored["conversation_ids"] = conversation_ids(stored["sources"])
                stored["version"] += 1
                stored["commit_time"] = now
                doomed = {
                    i
                    for i in item.delete_entry_ids
                    if rows.get(i, {}).get("topic_id") == item.topic_id
                    and rows[i]["status"] == ACTIVE
                }
                for row_id in [k for k, r in rows.items() if k in doomed or (
                        r["parent_decision_id"] in doomed)]:  # fmt: skip
                    del rows[row_id]
                for entry in item.upsert_entries:
                    if entry.id is None:
                        self._insert(rows, space.id, item.topic_id, entry, now)
                    else:
                        self._overwrite(rows, space.id, item.topic_id, entry, now)
                results.append(TopicChangeResult(topic_id=item.topic_id, operation="UPDATE"))
            for result in results:
                self._refresh_rank(topics, rows, result.topic_id)
            self._topics, self._rows = topics, rows
            return results

    def update_decision(self, decision_id, expected_update_time, content, embedding=None):
        if expected_update_time.tzinfo is None:
            raise ValueError("expected_update_time must be timezone-aware")
        with self._lock:
            row = self._rows.get(decision_id)
            if (
                row is None
                or row["entry_type"] != "decision"
                or row["status"] != ACTIVE
                or row["update_time"] != expected_update_time
            ):
                raise UpdateConflictError(f"Decision {decision_id} changed")
            row.update(content=content, version=row["version"] + 1, update_time=_now())
            self._rows = {
                k: r
                for k, r in self._rows.items()
                if not (r["parent_decision_id"] == decision_id and r["status"] == CONFLICT)
            }
            self._refresh_rank(self._topics, self._rows, row["topic_id"])
            return self._entry(row)

    def delete_topics(self, topic_ids):
        with self._lock:
            return self._drop_topics(list(topic_ids))

    def clear_space(self, space_id):
        with self._lock:
            space = self._require_space(space_id)
            space.clear_time = _now()
            return self._drop_topics(
                [k for k, v in self._topics.items() if v["space_id"] == space_id]
            )

    # ---------- search: not implemented ----------
    def search_topics_by_embedding(
        self, space_ids, query_vec, domains=None, filters=None, top_k=20
    ):
        raise NotImplementedError

    def search_topics_by_fulltext(
        self, space_ids, query_text, domains=None, filters=None, top_k=20
    ):
        raise NotImplementedError

    def search_entries_by_embedding(
        self, space_ids, query_vec, domains=None, filters=None, top_k=20, per_topic=6
    ):
        raise NotImplementedError

    def search_entries_by_fulltext(
        self, space_ids, query_text, domains=None, filters=None, top_k=20, per_topic=6
    ):
        raise NotImplementedError
