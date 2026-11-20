"""Fixed project data for HTTP integration tests before the project database is available."""

import operator

from memos.project_memory.index import Vector
from memos.project_memory.store import Hit, MissingSpaceError, Scope, UnknownDomainError
from memos.project_memory.views import component, parse_topic_filters, timestamp, topic_detail


SPACE = "mock-space"
SESSION = "mock-session"
TIME = "2026-01-15T10:00:00+08:00"
HEADER = {
    "id": "mock-topic",
    "domain": "代码开发",
    "topic_name": "项目记忆存储方案",
    "topic_summary": "项目记忆使用 PostgreSQL 存储，按空间检索。",
    "topic_description": "供接口联调使用的示例主题，包含数据库选型决策和联调经验。",
    "create_time": TIME,
    "update_time": TIME,
    "sources": [{"conversation_id": SESSION, "user_id": ["mock-user"], "agent_id": ["memmy"]}],
}
MESSAGE = {
    "message_id": "mock-message",
    "role": "user",
    "chat_time": TIME,
    "content": "这个项目的记忆统一存到 PostgreSQL，按项目空间查询。",
    "role_id": "mock-user",
}
TURN = {
    "id": "mock-turn",
    "turn_id": "mock-turn",
    "conversation_id": SESSION,
    "source_task_id": "mock-task",
    "message_ids": [MESSAGE["message_id"]],
    "topic_ids": [HEADER["id"]],
    "user_id": "mock-user",
    "agent_id": "memmy",
    "chat_time": TIME,
    "content": MESSAGE["content"],
    "cache_policy": "immutable",
}

ENTRIES = [
    (kind, {"id": f"mock-{kind}", "content": content, "time": TIME, "user_ids": ["mock-user"]})
    for kind, content in (
        ("decision", "项目记忆使用 PostgreSQL 存储。"),
        ("experience", "联调时先用检索返回的 ID 回查详情，确认读到的是同一条记忆。"),
        ("timeline", "项目记忆检索接口开始联调。"),
    )
]


class MockProjectStore:
    def __init__(self, tenant: str):
        self.tenant = tenant

    def spaces_by_tenant(self, scope: Scope) -> dict[str, list[str]]:
        if scope.tenant not in (None, self.tenant) or (
            scope.spaces is not None and SPACE not in scope.spaces
        ):
            return {}
        return {self.tenant: [SPACE]}

    def validate(self, scope: Scope) -> Scope:
        if set(scope.spaces or ()) != {SPACE} or not self.spaces_by_tenant(scope):
            raise MissingSpaceError
        if set(scope.domains) - {HEADER["domain"]}:
            raise UnknownDomainError
        return Scope(self.tenant, (SPACE,), scope.domains)

    def recall(
        self,
        scope: Scope,
        channel: str,
        query: str,
        vector: Vector | None,
        session: str | None,
        limit: int,
        item_types: tuple[str, ...],
        result_format: str,
        threshold: float,
    ) -> tuple[list[Hit], bool]:
        # A fixed match lets clients test response handling with any query text.
        if threshold > 1:
            return [], False
        if channel == "trajectory":
            rows = [("trajectory_detail_list", "trajectory", {**TURN, "space_id": SPACE})]
        elif result_format == "item":
            rows = [
                ("project_item_list", kind, component(kind, row, HEADER, SPACE, False))
                for kind, row in [("topic", HEADER), *ENTRIES]
                if kind in item_types
            ]
        else:
            entries = [(kind, row) for kind, row in ENTRIES if kind in item_types]
            rows = [("topic_detail_list", "topic", topic_detail(HEADER, SPACE, entries, False))]
        return [
            Hit(group, {**row, "relativity": 1.0}, 1.0, session == SESSION, kind)
            for group, kind, row in rows
        ], False

    def get(self, scope: Scope, memory_id: str, metadata_only: bool) -> dict | None:
        if not self.spaces_by_tenant(scope):
            return None
        for kind, row in [("topic", HEADER), *ENTRIES, ("trajectory", TURN)]:
            if memory_id != row["id"]:
                continue
            meta = {
                "id": memory_id,
                "space_id": SPACE,
                "kind": kind,
                "cache_policy": row.get("cache_policy", "live"),
            }
            if kind != "trajectory":
                meta["topic_id"] = HEADER["id"]
            if metadata_only:
                return meta
            if kind == "topic":
                return {**topic_detail(HEADER, SPACE, ENTRIES, True), **meta}
            if kind == "trajectory":
                return {**TURN, **meta}
            return {**component(kind, row, HEADER, SPACE, True), **meta}
        return None

    def list_topics(self, scope: Scope, page: int, size: int | None, filters: dict) -> dict:
        self.validate(scope)
        related, bounds = parse_topic_filters(filters)
        operators = {
            "gte": operator.ge,
            "gt": operator.gt,
            "lte": operator.le,
            "lt": operator.lt,
            "eq": operator.eq,
        }
        source = HEADER["sources"][0]
        matches = related is None or related in source["user_id"] or related in source["agent_id"]
        matches = matches and all(
            operators[op](timestamp(HEADER[field]), value) for field, op, value in bounds
        )
        rows = (
            [topic_detail(HEADER, SPACE, ENTRIES, True)]
            if matches and (size is None or page == 1)
            else []
        )
        return {"space_id": SPACE, "total": int(matches), "topic_detail_list": rows}

    def list_messages(self, space_id: str, conversation_id: str) -> list[dict]:
        return [dict(MESSAGE)] if (space_id, conversation_id) == (SPACE, SESSION) else []

    def log_recall(self, scope: Scope, session: str, topics: list[dict]) -> None:
        """The read-only fixture does not persist recall logs."""
