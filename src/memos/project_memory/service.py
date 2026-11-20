"""项目记忆服务：接口层与调度层只调这里。

写入：accept()（add 受理，同步）→ 调度消息 `project_memory`（一个会话一条流）→ execute()（异步）
      → 切段 → 每个关掉的段：归主题 → 决策（两次调用）‖ 经验 → 写库 → 任务记录更新主题 id。

并发（同一 Space 内也并行，见 locks.py）：
- 不同会话的段并行整理；同一会话按轮次顺序（会话锁）。
- 抽取类的大模型调用（归主题判断、决策判定与抽取、经验过滤与抽卡、经验合并判断）不加锁；
  一段之内决策与经验两条线并行。
- 改同一主题（摘要、时间线、决策更新）排队（主题锁）；新建主题、新建经验卡前在 Space 级的锁里
  复核一次，防止两段各建一个；改已有经验卡靠条件写。
- 锁默认是进程内的；多副本部署由工程注册 `H.PROJECT_MEMORY_LOCK` 换成分布式锁。
读取：search()（search/memory）、list_topics()（get/memory + space_id）、get_topic()（get/memory/{id}）。
管理：Space 4 个、领域 4 个、delete()、task_status()、get_message()。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from memos.graph_dbs.base import ConcurrentUpdateError

from . import decision as dec
from . import experience as exp
from . import topic as topic_mod
from .add_view import RelationalProjectView
from .graph_store import ProjectStore, cosine, lexical_sim
from .locks import InProcessLocks, conv_key, task_key, topic_key, topics_key
from .segmenter import IDLE_MINUTES, idle_minutes_between, segment, split_turns
from .types import (
    OP_ADD,
    PROJECT_DECISION,
    PROJECT_EXPERIENCE,
    Decision,
    Domain,
    Episode,
    Fenced,
    Msg,
    OrganizeResult,
    Space,
    TaskRecord,
    Topic,
    as_list,
    new_uuid,
    now_iso,
    time_key,
)


if TYPE_CHECKING:
    from .judge import ModelHub


logger = logging.getLogger(__name__)

PROJECT_MEMORY_TASK_LABEL = "project_memory"  # re-exported for callers; source of truth is handler
MAX_DOMAINS = 20
DEFAULT_LIMIT = 9  # PRD search/memory 的默认条数
MAX_LIMIT = 25  # PRD 的上限；超过按上限截断、不报错（校验在工程层）
REL_MIN = 0.12  # 条目与 query 的最低相关度（二元组相似度；接真向量后在评测集上定）
MAX_ENTRIES = 5
EXP_CONTENT_MAX = 200  # PRD：经验条目内容不超过 200 字
MAX_CAS_RETRIES = 3
MAX_TRACE_LINES = 80
MAX_ORGANIZE_RETRIES = 3  # 一段整理失败最多重试几次，之后标 failed

Submit = Callable[[list[Any]], Any]
_TZ_SUFFIX = re.compile(r"[+-]\d{2}:?\d{2}$|Z$")  # chat_time 末尾的时区偏移
_OFFSET = re.compile(r"^[+-]\d{2}:\d{2}$")


def naive_tz() -> timezone:
    """没带时区的 chat_time 按哪个时区理解：`PROJECT_MEMORY_NAIVE_TZ`（如 `+08:00`），
    没配就用服务器本地时区。只认偏移量写法：精简镜像里常没有时区数据库，按名字配会悄悄退回 UTC。"""
    raw = (os.getenv("PROJECT_MEMORY_NAIVE_TZ") or "").strip()
    if _OFFSET.match(raw):
        sign = -1 if raw[0] == "-" else 1
        hours, minutes = int(raw[1:3]), int(raw[4:6])
        return timezone(sign * timedelta(hours=hours, minutes=minutes))
    return datetime.now().astimezone().tzinfo  # type: ignore[return-value]


def ensure_tz(t: str) -> str:
    """给没带时区的时间补上时区；带了的原样返回，解析不了的也原样返回。"""
    if not t or _TZ_SUFFIX.search(t):
        return t
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return t
    return dt.replace(tzinfo=naive_tz()).isoformat(timespec="seconds")


class ProjectMemoryService:
    def __init__(
        self,
        store: ProjectStore | RelationalProjectView,
        hub: ModelHub,
        submit: Submit | None = None,
        lock: Callable[[str], Any] | None = None,
    ):
        self.store = store
        self.hub = hub
        self.submit = submit
        # `key -> 上下文管理器`；默认进程内锁，插件会在工程注册了分布式锁时换掉
        self.lock: Callable[[str], Any] = lock or InProcessLocks()
        self.parallel_episode = (
            os.getenv("PROJECT_MEMORY_PARALLEL_EPISODE", "true").lower() == "true"
        )
        self.last_trace: list[str] = []  # 最近一次整理的 trace（调试、演示用）

    # ═════════════════════════════════ Space ═════════════════════════════════

    def create_space(
        self, space_name: str, instructions: str = "", domains: list[dict] | None = None
    ) -> Space:
        if not space_name or not space_name.strip():
            raise ValueError("space_name 不能为空")
        space = Space(
            space_id=new_uuid(), space_name=space_name.strip(), instructions=instructions or ""
        )
        if domains:
            space.domains = self._validate_new_domains(space, domains)
        self.store.put_space(space)
        return space

    def get_space(self, space_id: str) -> Space:
        space = self.store.get_space(space_id)
        if space is None:
            raise LookupError(f"Space 不存在：{space_id}")
        return space

    def update_space(
        self, space_id: str, space_name: str | None = None, instructions: str | None = None
    ) -> Space:
        space = self.get_space(space_id)
        if space_name is not None:
            if not space_name.strip():
                raise ValueError("space_name 不能为空")
            space.space_name = space_name.strip()
        if instructions is not None:
            space.instructions = instructions
        self.store.put_space(space)
        return space

    def delete_space(self, space_id: str) -> dict[str, Any]:
        self.get_space(space_id)
        for t in self.store.list_topics(space_id):
            self.store.delete_index(f"topic:{t.id}")
        n = self.store.delete_space_nodes(space_id)
        return {"space_id": space_id, "deleted_nodes": n}

    # ═════════════════════════════════ 领域 ══════════════════════════════════

    def _validate_new_domains(self, space: Space, domains: list[dict]) -> list[Domain]:
        """已登记的同名领域跳过、保留原名称与说明（PRD create/domains）；
        同一批里重名的整批失败（PRD 领域管理共同规则）。"""
        registered = set(space.domain_names())
        names: list[str] = []
        for d in domains:
            name = (d.get("name") if isinstance(d, dict) else d) or ""
            if not str(name).strip():
                raise ValueError("领域名称不能为空")
            names.append(str(name).strip())
        _reject_batch_duplicates(names)
        out: list[Domain] = []
        for d, name in zip(domains, names, strict=True):
            if name in registered:
                continue
            out.append(
                Domain(
                    name=name,
                    description=(d.get("description") or "") if isinstance(d, dict) else "",
                )
            )
        if len(space.domains) + len(out) > MAX_DOMAINS:
            raise ValueError(f"每个 Space 最多 {MAX_DOMAINS} 个领域")
        return out

    def create_domains(self, space_id: str, domains: list[dict]) -> list[dict]:
        space = self.get_space(space_id)
        # 整批校验，失败不落任何一个；同名的跳过（PRD）
        space.domains += self._validate_new_domains(space, domains)
        self.store.put_space(space)
        return [d.__dict__ for d in space.domains]

    def update_domains(self, space_id: str, domains: list[dict]) -> list[dict]:
        """每项 {name, new_name?, description?}。改名同步到已有主题。"""
        space = self.get_space(space_id)
        _reject_batch_duplicates([d.get("name") for d in domains])
        by_name = {d.name: d for d in space.domains}
        final = set(by_name)
        renames: dict[str, str] = {}
        for d in domains:
            name = d.get("name")
            if name not in by_name:
                raise ValueError(f"领域未登记：{name}")
            new = d.get("new_name")
            if new:
                new = new.strip()
                if not new or (new in final and new != name):
                    raise ValueError(f"领域改名冲突：{name} → {new}")
                final.discard(name)
                final.add(new)
                renames[name] = new
        for d in domains:
            dom = by_name[d["name"]]
            if d.get("description") is not None:
                dom.description = d["description"]
            if d["name"] in renames:
                dom.name = renames[d["name"]]
        self.store.put_space(space)
        if renames:
            for t in self.store.list_topics(space_id):
                if t.domain in renames:
                    t.domain = renames[t.domain]
                    self.store.put_topic(t, touch=False)  # 改名不算主题更新，不打乱按时间的排序
        return [d.__dict__ for d in space.domains]

    def delete_domains(self, space_id: str, names: list[str]) -> list[dict]:
        space = self.get_space(space_id)
        _reject_batch_duplicates(names)
        registered = set(space.domain_names())
        names = [n for n in names if n in registered]  # 已不存在的名称忽略（PRD）
        used = {t.domain for t in self.store.list_topics(space_id)}
        busy = [n for n in names if n in used]
        if busy:
            raise ValueError(f"领域仍被主题引用，不能删除：{busy}")
        space.domains = [d for d in space.domains if d.name not in names]
        self.store.put_space(space)
        return [d.__dict__ for d in space.domains]

    def list_domains(self, space_id: str) -> list[dict]:
        return [d.__dict__ for d in self.get_space(space_id).domains]

    # ═════════════════════════════════ 写入 ══════════════════════════════════

    def accept(self, req: Any) -> dict[str, Any]:
        """add/message 受理（同步部分）：校验、存消息、建任务、按 Space 入队。"""
        from memos.api.project_fields import normalize_str_list

        space_ids: list[str] = normalize_str_list(getattr(req, "space_ids", None), "space_ids")
        domains: list[str] = normalize_str_list(getattr(req, "domains", None), "domains")
        # user_id 可能是字符串（开源版）也可能是字符串数组（企业版允许多 cube）
        raw_uid = req.user_id
        user_id = (raw_uid[0] if raw_uid else "") if isinstance(raw_uid, list) else raw_uid or ""
        spaces = [self.get_space(s) for s in space_ids]  # 任一不存在 → 「Space 不存在」
        for sp in spaces:
            if not sp.domains:
                raise ValueError(
                    f"未配置领域：Space {sp.space_id} 至少登记一个领域后才能写入项目记忆"
                )
            bad = [d for d in domains if d not in sp.domain_names()]
            if bad:
                raise ValueError(f"领域未登记：{bad}（Space {sp.space_id}）")

        conv = getattr(req, "conversation_id", None) or getattr(req, "session_id", None) or None
        if conv == "default_session":
            conv = None
        # user_id already resolved above (handles str or list); re-use it.
        # agent_id：PRD 规定原样记录，群聊多 Agent 时是数组；只有一个元素的数组按字符串记
        agents = as_list(getattr(req, "agent_id", None))
        agent_id: Any = agents[0] if len(agents) == 1 else agents or ""
        # 方案 A：工程层照个人记忆链路发内部 ID，另带 内部 ID → 外部 ID 的对照表；
        # 项目记忆存外部 ID（表里没有的原样保留）
        member_map = getattr(req, "project_member_map", None) or {}
        if member_map:
            uids = [member_map.get(u, u) for u in as_list(req.user_id)]
            user_id = uids[0] if uids else user_id
            agents = [member_map.get(a, a) for a in agents]
            agent_id = agents[0] if len(agents) == 1 else agents or ""
        msgs = parse_messages(req.messages or [], user_id)
        if member_map:
            for m in msgs:
                if m.user_id in member_map:
                    m.user_id = member_map[m.user_id]
        task = TaskRecord(
            task_id=getattr(req, "task_id", None) or new_uuid(),
            user_id=user_id,
            space_ids=space_ids,
            pending_spaces=list(space_ids),
        )
        payloads: list[tuple[str, dict[str, Any]]] = []
        for sp in spaces:
            space_id = sp.space_id
            node_ids = self._store_messages(space_id, conv, msgs, user_id, agent_id)
            task.message_ids += node_ids
            payloads.append(
                (
                    space_id,
                    {
                        "task_id": task.task_id,
                        "conversation_id": conv,
                        "message_node_ids": node_ids,
                        "domains": domains,
                        "user_id": user_id,
                        "agent_id": agent_id,
                        "epoch": sp.epoch,  # 整理前核对：清空后不再写回清空前的内容
                    },
                )
            )
        self.store.put_task(task)
        for space_id, payload in payloads:
            if conv:
                idx = self.store.get_index(f"conv:{conv}") or {"space_ids": []}
                if space_id not in idx["space_ids"]:
                    idx["space_ids"].append(space_id)
                    self.store.put_index(f"conv:{conv}", idx)
            self._enqueue(space_id, payload, sync=getattr(req, "async_mode", "async") == "sync")

        task = self.store.get_task(task.task_id) or task
        # 同步模式下整理已经跑完：失败要让调用方看得出来
        status = task.status if task.status in ("completed", "failed") else "running"
        out = {
            "success": status != "failed",
            "task_id": task.task_id,
            "status": status,
            "memory_view": "project",
        }
        if status == "failed" and task.error:
            out["error"] = task.error
        return out

    def _store_messages(
        self, space_id: str, conv: str | None, msgs: list[Msg], user_id: str, agent_id: Any
    ) -> list[str]:
        """按 PRD 去重：同一会话里 role + chat_time 相同的视为已有消息，不重复保存。"""
        existing = self.store.list_messages(space_id, conv) if conv else []
        seen = {(m.role, m.chat_time, m.text) for m in existing if m.chat_time}
        seq0 = max([m.seq for m in existing] + [0])
        ids: list[str] = []
        for i, m in enumerate(msgs):
            if conv and m.chat_time and (m.role, m.chat_time, m.text) in seen:
                continue
            m.seq = seq0 + i + 1
            m.node_id = new_uuid()
            ids.append(
                self.store.put_message(
                    space_id, conv or "", m, {"user_id": user_id, "agent_id": agent_id}
                )
            )
        return ids

    def _enqueue(self, space_id: str, payload: dict[str, Any], sync: bool) -> None:
        if self.submit is not None and not sync:
            from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem

            item = ScheduleMessageItem(
                # 一个会话一条流：调度器按 (user_id, mem_cube_id) 分组派给线程池，
                # 同一 Space 的不同会话因此并行。mem_cube_id 与 task_id 不动——企业版
                # 调度完成后经 RabbitMQ 回写任务状态，工程层按 (mem_cube_id, task_id) 对账。
                user_id=stream_owner(space_id, payload.get("conversation_id")),
                mem_cube_id=space_id,
                label=PROJECT_MEMORY_TASK_LABEL,
                content=json.dumps(payload, ensure_ascii=False),
                user_name=space_id,
                task_id=payload["task_id"],
            )
            self.submit([item])
            return
        self.run_item(space_id, payload)

    # —— 调度入口（H.PROJECT_MEMORY_EXECUTE）——
    def execute(self, space_id: str, batch: list[Any]) -> None:
        items = sorted(batch, key=lambda m: getattr(m, "timestamp", None) or 0)
        for item in items:
            try:
                payload = json.loads(item.content)
            except (TypeError, ValueError):
                logger.warning(
                    "[ProjectMemory] 调度消息不是 JSON，跳过：%s",
                    getattr(item, "content", "")[:200],
                )
                continue
            self.run_item(space_id, payload)

    def run_item(self, space_id: str, payload: dict[str, Any]) -> OrganizeResult:
        result = OrganizeResult()
        task_id = payload["task_id"]
        try:
            space = self.store.get_space(space_id)
            if space is None or int(payload.get("epoch") or 0) < space.epoch:
                # Space 已删除，或受理后被清空：清空前提交的内容不再整理（PRD 删除围栏）
                result.log("Space 已删除或已清空，这批消息不整理")
                self._finish_task(task_id, space_id, [], 0, error="", trace=result.trace)
                return result
            conv = payload.get("conversation_id")
            new_msgs = self.store.get_messages(space_id, payload.get("message_node_ids") or [])
            # 先重试之前整理失败的段（模型临时不可用等），最多 MAX_ORGANIZE_RETRIES 次
            for pe in self.store.episodes(space_id, "pending"):
                result.trace += self._retry_pending(pe).trace
            # 懒关段：先把这个 Space 里别的会话空闲超过阈值的段关掉（会话最后一段没有「下一轮」
            # 来触发，照 memmy 的做法在每次整理前扫一遍；会话结束时接入方也可调 flush）。
            # 「现在」取这批消息的时间而不是墙钟：导入历史会话时消息时间都很早，按墙钟会把
            # 每一段都判成空闲。每个别的会话单独拿它的锁、用完就放，不与本会话的锁嵌套。
            # 关掉的段整理出的主题记到那些段自己的任务上，不记到本任务。
            ref = new_msgs[0].chat_time if new_msgs and new_msgs[0].chat_time else now_iso()
            for stale in self.store.open_episodes(space_id):
                if conv and stale.conversation_id == conv:
                    continue  # 本会话的段由 segment() 按消息时间判
                result.trace += self._close_if_idle(space_id, stale, ref).trace

            with self.lock(conv_key(space_id, conv or f"task-{task_id}")):
                open_ep = self.store.open_episode(space_id, conv) if conv else None
                if open_ep is None and conv:
                    # 上一段归属不清、暂缓了：和这次的新消息并成一段再判（PRD）
                    deferred = self.store.episodes(space_id, "deferred", conv)
                    if deferred:
                        open_ep = deferred[-1]
                        open_ep.state = "open"
                        result.log("接上暂缓的那一段一起整理")
                prev_tail = [] if open_ep else self._last_tail(space_id, conv)
                prev_space = ""
                if not open_ep and not prev_tail and conv:
                    # 会话首次写入这个 Space：借用此前提交到别的 Space 的最后一轮作上下文（PRD）
                    prev_space, prev_tail = self._borrow_tail(space_id, conv)
                closed, still_open = segment(
                    self.hub,
                    space_id,
                    conv,
                    open_ep,
                    new_msgs,
                    load=lambda ids: self.store.get_messages(space_id, ids),
                    domains=payload.get("domains") or [],
                    task_id=task_id,
                    log=result.log,
                    prev_tail=prev_tail,
                    epoch=int(payload.get("epoch") or 0),
                )
                for ep in [*closed, *([still_open] if still_open else [])]:
                    if prev_space and ep.prev_message_ids == prev_tail:
                        ep.prev_space_id = prev_space
                    ep.agent_id = ep.agent_id or payload.get("agent_id", "")
                for ep in closed:
                    result.merge(self._organize_or_park(ep))
                if still_open is not None:
                    self.store.put_episode(still_open)
            self._finish_task(
                task_id,
                space_id,
                result.topic_ids,
                0,
                error="；".join(result.errors),
                trace=result.trace,
            )
        except Exception as e:
            logger.exception("[ProjectMemory] 整理失败 space=%s task=%s", space_id, task_id)
            result.log(f"失败：{e}")
            self._finish_task(
                task_id, space_id, result.topic_ids, 0, error=str(e), trace=result.trace
            )
        self.last_trace = result.trace
        return result

    def _borrow_tail(self, space_id: str, conv: str) -> tuple[str, list[str]]:
        """这个会话此前写到别的 Space 的最后一轮（消息节点在那个 Space 里）。"""
        idx = self.store.get_index(f"conv:{conv}") or {}
        for other in idx.get("space_ids") or []:
            if other == space_id:
                continue
            turns = split_turns(self.store.list_messages(other, conv))
            if turns:
                return other, [m.node_id for m in turns[-1]]
        return "", []

    def _close_if_idle(self, space_id: str, stale: Episode, ref: str) -> OrganizeResult:
        """别的会话的段空闲超时就关掉整理。拿那个会话的锁后重读一次：别的线程可能刚处理过它。"""
        conv = stale.conversation_id or f"episode-{stale.id}"
        with self.lock(conv_key(space_id, conv)):
            cur = (
                self.store.open_episode(space_id, stale.conversation_id)
                if stale.conversation_id
                else stale
            )
            if cur is None or cur.id != stale.id:
                return OrganizeResult()
            last = self.store.get_messages(space_id, cur.message_ids)
            gap = idle_minutes_between(last[-1].chat_time, ref) if last else None
            if gap is None or gap < IDLE_MINUTES:
                return OrganizeResult()
            return self._close_and_organize(cur, "idle_timeout")

    def _close_and_organize(self, ep: Episode, reason: str) -> OrganizeResult:
        ep.state, ep.closed_reason = "closed", reason
        self.store.put_episode(ep)
        return self._organize_or_park(ep)

    def _retry_pending(self, ep: Episode) -> OrganizeResult:
        conv = ep.conversation_id or f"episode-{ep.id}"
        with self.lock(conv_key(ep.space_id, conv)):
            cur = next(
                (e for e in self.store.episodes(ep.space_id, "pending") if e.id == ep.id), None
            )
            if cur is None:
                return OrganizeResult()  # 别的线程刚重试过
            cur.state = "closed"
            return self._organize_or_park(cur)

    def _organize_or_park(self, ep: Episode) -> OrganizeResult:
        """整理一段。失败时这段不丢：标成 pending 等下次写入或 flush 时重试，重试
        MAX_ORGANIZE_RETRIES 次仍失败标 failed；Space 被删除或清空则丢弃。整理出的主题记到
        这段消息来自的全部任务上。"""
        try:
            r = self.organize(ep)
        except Fenced as e:
            ep.state = "discarded"
            self.store.put_episode(ep)
            r = OrganizeResult()
            r.log(f"关段（{ep.closed_reason}）：{e}，这一段的结果不写回")
            return r
        except Exception as e:
            logger.exception("[ProjectMemory] 整理一段失败 space=%s episode=%s", ep.space_id, ep.id)
            ep.retries += 1
            ep.state = "failed" if ep.retries >= MAX_ORGANIZE_RETRIES else "pending"
            self.store.put_episode(ep)
            r = OrganizeResult(failed_episodes=1, errors=[f"整理失败（第 {ep.retries} 次）：{e}"])
            r.log(
                r.errors[0]
                + ("，不再重试" if ep.state == "failed" else "，下次写入或 flush 时重试")
            )
            return r
        self._attach(ep.task_ids, r.topic_ids)
        return r

    def _attach(self, task_ids: list[str], topic_ids: list[str]) -> None:
        """把整理出的主题记到任务上；不改任务状态（状态只由任务自己那次整理来改）。"""
        if not topic_ids:
            return
        for tid in dict.fromkeys(task_ids):
            with self.lock(task_key(tid)):
                task = self.store.get_task(tid)
                if task is None:
                    continue
                new = [t for t in topic_ids if t not in task.memory_ids]
                if new:
                    task.memory_ids += new
                    self.store.put_task(task)

    def flush(
        self,
        space_id: str,
        conversation_id: str | None = None,
        task_id: str | None = None,
    ) -> OrganizeResult:
        """会话结束：把这个 Space（或这个会话）里还开着的段立即关掉并整理。

        本地插件在会话结束时调；也可以由定时任务调。不调的话，这些段会在下一次同 Space 的
        整理时按空闲超时关掉，最慢等到下一次有人写。

        传了 `task_id` 时把这次整理出的主题也记到那个任务上（`get/status` 看得到）；不改它的
        状态。之前整理失败待重试的段一并重试；暂缓的段（归属不清）会话已结束，丢弃。
        """
        self.get_space(space_id)  # Space 不存在 → LookupError → 404
        out = OrganizeResult()
        for ep in self.store.episodes(space_id, "pending", conversation_id):
            out.merge(self._retry_pending(ep))
        for ep in self.store.episodes(space_id, "deferred", conversation_id):
            ep.state = "discarded"
            self.store.put_episode(ep)
            out.log("会话结束：暂缓的那一段仍看不出是哪项工作，丢弃")
        for ep in self.store.open_episodes(space_id):
            if conversation_id and ep.conversation_id != conversation_id:
                continue
            conv = ep.conversation_id or f"episode-{ep.id}"
            with self.lock(conv_key(space_id, conv)):
                cur = (
                    self.store.open_episode(space_id, ep.conversation_id)
                    if ep.conversation_id
                    else ep
                )
                if cur is None or cur.id != ep.id:
                    continue  # 别的线程刚关过
                out.merge(self._close_and_organize(cur, "session_end"))
        if task_id:
            self._attach([task_id], out.topic_ids)
        if out.trace:
            self.last_trace = out.trace
        return out

    def _last_tail(self, space_id: str, conv: str | None) -> list[str]:
        if not conv:
            return []
        nodes = self.store._nodes(
            "ProjectEpisodeMemory",
            space_id,
            [
                {"field": "conversation_id", "op": "=", "value": conv},
                {"field": "episode_state", "op": "=", "value": "closed"},
            ],
        )
        if not nodes:
            return []
        nodes.sort(key=lambda n: n["metadata"].get("create_time", ""))
        ids = nodes[-1]["metadata"].get("message_ids") or []
        turns = split_turns(self.store.get_messages(space_id, ids))
        return [m.node_id for m in turns[-1]] if turns else []

    def _finish_task(
        self,
        task_id: str,
        space_id: str,
        topic_ids: list[str],
        open_n: int,
        error: str,
        trace: list[str] | None = None,
    ) -> None:
        # 一次 add 写进多个 Space 时，各 Space 的整理会并行累加到同一条任务记录上
        with self.lock(task_key(task_id)):
            task = self.store.get_task(task_id)
            if task is None:
                return
            if trace:
                task.trace = (task.trace + trace)[-MAX_TRACE_LINES:]
            for t in topic_ids:
                if t not in task.memory_ids:
                    task.memory_ids.append(t)
            task.pending_spaces = [s for s in task.pending_spaces if s != space_id]
            if error:
                task.status, task.error = "failed", error
            elif not task.pending_spaces and task.status != "failed":
                task.status = "completed"
            self.store.put_task(task)

    # —— 一段的整理 ——
    def organize(self, ep: Episode) -> OrganizeResult:
        r = OrganizeResult()
        ep.messages = self.store.get_messages(ep.space_id, ep.message_ids)
        ep.prev = self.store.get_messages(ep.prev_space_id or ep.space_id, ep.prev_message_ids)
        ep.fence = lambda: self._fence_ok(ep)
        r.log(f"关段（{ep.closed_reason}）：{len(ep.messages)} 条消息")
        space = self.get_space(ep.space_id)
        if space.epoch > ep.epoch:
            raise Fenced("Space 已清空")
        domains = ep.domains or space.domain_names()
        topic = self._assign_topic(space, ep, domains, r)
        if topic is None:
            if ep.skip_reason == "unclear" and ep.conversation_id and not ep.deferred:
                # 看不出是哪项工作：先放着，等同一会话的下一段消息来了一起判（PRD）
                ep.state, ep.deferred = "deferred", True
                r.log("  归属不清，暂缓，等这个会话的下一段一起整理")
            self.store.put_episode(ep)
            return r
        ep.topic_id = topic.id
        r.topic_ids.append(topic.id)

        # 决策与经验改的是不同的记录、互不依赖对方的结果：一段之内两条线并行
        r_dec, r_exp = OrganizeResult(), OrganizeResult()

        def run_exp() -> None:
            r_exp.experience_ops += exp.run(self.hub, self.store, ep, r_exp.log, lock=self.lock)

        if self.parallel_episode:
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="pm-exp") as pool:
                fut = pool.submit(_with_context(run_exp))
                self._run_decisions(ep, topic, r_dec)
                fut.result()
        else:
            self._run_decisions(ep, topic, r_dec)
            run_exp()
        r.merge(r_dec)
        r.merge(r_exp)
        self.store.put_episode(ep)
        return r

    def _fence_ok(self, ep: Episode) -> bool:
        """写库前核对：Space 还在、没被清空，并入的主题没被删。"""
        space = self.store.get_space(ep.space_id)
        if space is None or space.epoch > ep.epoch:
            return False
        return not ep.topic_id or self.store.get_topic(ep.topic_id, ep.space_id) is not None

    def _assign_topic(
        self, space: Space, ep: Episode, domains: list[str], r: OrganizeResult
    ) -> Topic | None:
        """归主题：判断不加锁；并入已有主题拿主题锁，新建主题拿主题列表锁并先复核。"""
        sid = space.space_id
        choice = topic_mod.choose(self.hub, self.store, space, ep, domains, r.log)
        if choice.skip:
            return None
        if not self._fence_ok(ep):
            raise Fenced("Space 已删除或已清空")
        if choice.topic_id is None:
            with self.lock(topics_key(sid)):
                if topic_mod.changed_since(self.store, sid, choice):
                    r.log("归主题：判断期间别的段新建了主题，带上新主题重判")
                    choice = topic_mod.choose(self.hub, self.store, space, ep, domains, r.log)
                    if choice.skip:
                        return None
                if choice.topic_id is None:
                    return topic_mod.apply(self.store, space, ep, choice, domains, r.log)
        with self.lock(topic_key(sid, choice.topic_id)):
            return topic_mod.apply(self.store, space, ep, choice, domains, r.log)

    def _run_decisions(self, ep: Episode, topic: Topic, r: OrganizeResult) -> None:
        # 判定与抽取只看这一段，不加锁
        existing = self.store.list_decisions(ep.space_id, topic.id)
        members = ep.member_names()
        for d in existing:
            for name in d.user_labels.values():
                if name and name not in members:
                    members.append(name)
        has, drafts = dec.extract(self.hub, ep, members)
        r.log(f"  决策判定：{'有' if has else '无'}（抽出 {len(drafts)} 条）")
        if not has:
            return
        kept, dropped = dec.verify(ep, drafts, members)
        r.dropped += dropped
        for x in dropped:
            r.log(f"  决策丢弃：{x['reason']}｜{x['quote']}")
        if not kept:
            return

        # 更新要和这个主题已有的决策比：同一主题排队，否则两段相反的结论会都当新增、分歧丢失
        with self.lock(topic_key(ep.space_id, topic.id)):
            existing = self.store.list_decisions(ep.space_id, topic.id)  # 拿锁后重读
            existing = sorted(existing, key=lambda d: d.time, reverse=True)[
                : dec.MAX_TOPIC_DECISIONS
            ]
            if not existing:  # 召回为空：不调第二次，直接新增
                for d in kept:
                    self._add(d, ep, topic, r, "主题里还没有决策")
                return

            rows = dec.update(self.hub, kept, existing, topic.name)
            touched: set[str] = set()
            for d, row in zip(kept, rows, strict=False):
                for attempt in range(MAX_CAS_RETRIES):
                    cands = {x.id: x for x in self.store.list_decisions(ep.space_id, topic.id)}
                    if attempt or row.get("decision_id") in touched:
                        # 同一段里前一条已改过这条决策，或写回时发现被别人改过：按新状态重判
                        row = dec.update(self.hub, [d], list(cands.values()), topic.name)[0]
                    plan = dec.decide(d, row, cands)
                    try:
                        self._apply_plan(d, plan, cands, ep, topic, r, touched)
                        break
                    except ConcurrentUpdateError:
                        r.log(
                            f"  决策写回冲突（第 {attempt + 1} 次）："
                            "这条决策刚被别的任务改过，重读重判"
                        )
                else:
                    r.log(f"  决策写回连续冲突 {MAX_CAS_RETRIES} 次，放弃这一条：{d.content}")

    def _apply_plan(
        self, d, plan, cands, ep: Episode, topic: Topic, r: OrganizeResult, touched: set[str]
    ) -> None:
        if not self._fence_ok(ep):
            raise Fenced("Space 已删除或已清空，或主题已删除")
        for g in plan.guarded:
            r.log(f"  决策护栏：{g}")
        if plan.action == OP_ADD:
            self._add(d, ep, topic, r, plan.reason)
            return
        before = cands[plan.decision_id]
        after, plan = dec.apply(before, plan, d, ep.conversation_id)
        if after is None:
            r.log(f"  决策 {plan.action}：{d.name} 已在那一项里，不写入")
            return
        self.store.put_decision(after, expected_rev=before.rev)
        touched.add(after.id)
        r.decision_ops.append(
            {
                "op": plan.action,
                "decision_id": after.id,
                "same_as": plan.same_as,
                "model_action": plan.model_action,
                "guarded": plan.guarded,
                "reason": plan.reason,
                "content": after.content,
                "conflicts": [c.content for c in after.conflicts],
                "history": [h.content for h in after.history],
            }
        )
        r.log(
            f"  决策 {plan.action}（{plan.same_as or '-'}）→ 当前结论「{after.content}」；"
            f"不一致 {len(after.conflicts)} 项；历史 {len(after.history)} 项"
        )

    def _add(self, d, ep: Episode, topic: Topic, r: OrganizeResult, reason: str) -> None:
        if not self._fence_ok(ep):
            raise Fenced("Space 已删除或已清空，或主题已删除")
        new = dec.new_decision(d, ep, topic.id)
        self.store.put_decision(new)
        r.decision_ops.append(
            {"op": OP_ADD, "decision_id": new.id, "content": new.content, "reason": reason}
        )
        r.log(f"  决策 add：{new.content}")

    # ═════════════════════════════════ 读取 ══════════════════════════════════

    def search(self, req: Any) -> list[dict[str, Any]]:
        """按主题返回（`topic_detail_list` 的内容）。"""
        return self.search_result(req).get("topic_detail_list", [])

    def search_result(self, req: Any) -> dict[str, Any]:
        """search/memory：`project_result_format` 为 topic（默认）时返回 `topic_detail_list`，
        为 item 时返回平铺的 `project_item_list`（一个组件一项）；`project_item_types` 限定组件类别。"""
        # 没显式传就用项目记忆自己的默认值：企业版请求模型里这个字段默认 10、上限 30，
        # 是给个人记忆用的，不能直接拿来当主题条数
        explicit = "memory_limit_number" in (getattr(req, "model_fields_set", None) or set())
        given = getattr(req, "memory_limit_number", None) if explicit else None
        limit = max(1, min(int(given or DEFAULT_LIMIT), MAX_LIMIT))
        types = _item_types(req)
        fmt = getattr(req, "project_result_format", None) or "topic"
        if fmt not in ("topic", "item"):
            raise ValueError("project_result_format 只支持 topic / item")
        query = req.query
        conv = getattr(req, "conversation_id", None) or getattr(req, "session_id", None)
        scored = self._scored_topics(req, query, conv, limit)
        if fmt == "topic":
            return {
                "topic_detail_list": [
                    self.topic_detail(t, query=query, relativity=min(1.0, s), types=types)
                    for s, t in scored[:limit]
                ]
            }
        items: dict[str, dict[str, Any]] = {}
        for s, t in scored:
            for it in self._topic_items(t, query, min(1.0, s), types):
                if it["id"] not in items or it["relativity"] > items[it["id"]]["relativity"]:
                    items[it["id"]] = it
        ranked = sorted(items.values(), key=lambda x: x["relativity"], reverse=True)
        return {"project_item_list": ranked[:limit]}

    def check_search(self, req: Any) -> None:
        """只做校验（Space 存在、领域已登记、组件参数合法），混合检索在核心链路里真正检索前调。"""
        _item_types(req)
        if (getattr(req, "project_result_format", None) or "topic") not in ("topic", "item"):
            raise ValueError("project_result_format 只支持 topic / item")
        domains = as_list(getattr(req, "domains", None))
        for space_id in as_list(req.space_ids):
            space = self.get_space(space_id)
            bad = [d for d in domains if d not in space.domain_names()]
            if bad:
                raise ValueError(f"领域未登记：{bad}（Space {space_id}）")

    def _scored_topics(self, req: Any, query: str, conv: str | None, limit: int):
        scored: list[tuple[float, Topic]] = []
        domains = as_list(getattr(req, "domains", None))  # 字符串按单元素数组处理
        for space_id in as_list(req.space_ids):
            space = self.get_space(space_id)
            bad = [d for d in domains if d not in space.domain_names()]
            if bad:
                raise ValueError(f"领域未登记：{bad}（Space {space_id}）")
            for s, t in self.store.recall_topics(space_id, query, limit * 2, domains=domains):
                if conv and any(src.get("conversation_id") == conv for src in t.sources):
                    s += 0.1  # 来源会话包含当前会话的主题优先
                scored.append((s, t))
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored

    # —— 组件（主题、决策、经验、进展各自平铺成一项）——
    def _item(self, kind: str, t: Topic, base: dict[str, Any], rel: float | None) -> dict[str, Any]:
        out = {
            "item_type": kind,
            **base,
            "topic_id": t.id,
            "space_id": t.space_id,
            "domain": t.domain,
            "topic_name": t.name,
        }
        if rel is not None:
            out["relativity"] = round(rel, 4)
        return out

    def _topic_base(self, t: Topic, full: bool) -> dict[str, Any]:
        out = {
            "id": t.id,
            "content": t.summary,
            "time": t.update_time,
            "user_ids": sorted(t.related_user_ids()),
            "topic_description": t.description,
        }
        if full:
            out["sources"] = t.sources
            out["create_time"] = t.create_time
        return out

    @staticmethod
    def _timeline_base(x: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": x.get("id", ""),
            "content": x.get("content", ""),
            "time": x.get("time", ""),
            "user_ids": x.get("user_ids", []),
        }

    def _topic_items(self, t: Topic, query: str, rel: float, types: list[str]) -> list[dict]:
        out: list[dict[str, Any]] = []
        if "topic" in types:
            out.append(self._item("topic", t, self._topic_base(t, False), rel))
        if "decision" in types:
            ds = self.store.list_decisions(t.space_id, t.id)
            for s, d in self._scored(query, ds, lambda d: d.index_text):
                out.append(self._item("decision", t, self._decision_out(d, False), s))
        if "experience" in types:
            es = [
                e
                for e in self.store.list_experiences(t.space_id)
                if t.id in e.topic_ids and exp.lifecycle(e) != "archived"
            ]
            for s, e in self._scored(
                query, es, lambda e: e.memory_text, weight=lambda e: e.confidence
            ):
                out.append(self._item("experience", t, self._experience_out(e, False), s))
        if "timeline" in types:
            tl = [x for x in t.timeline if x.get("id")]
            for s, x in self._scored(query, tl, lambda x: x.get("content", "")):
                out.append(self._item("timeline", t, self._timeline_base(x), s))
        return out

    def get_by_id(self, memory_id: str) -> dict[str, Any] | None:
        """主题 ID → `topic_detail_list`；决策、经验、进展条目的 ID → `project_item_list`（完整
        字段）；都不是 → None（走核心原有逻辑）。"""
        t = self.store.get_topic(memory_id)
        if t is not None:
            return {"topic_detail_list": [self.topic_detail(t)]}
        idx = self.store.get_index(f"timeline:{memory_id}")
        if idx:
            t = self.store.get_topic(idx.get("topic_id", ""), idx.get("space_id"))
            x = next((x for x in (t.timeline if t else []) if x.get("id") == memory_id), None)
            if t is None or x is None:
                return None
            return {"project_item_list": [self._item("timeline", t, self._timeline_base(x), None)]}
        node = self.store.find_node(memory_id)
        if node is None:
            return None
        mt = node["metadata"].get("memory_type")
        space_id = node["metadata"].get("user_name")
        if mt == PROJECT_DECISION:
            d = self.store.get_decision(memory_id, space_id)
            t = self.store.get_topic(d.topic_id, space_id) if d else None
            if d is None or t is None:
                return None
            return {
                "project_item_list": [self._item("decision", t, self._decision_out(d, True), None)]
            }
        if mt == PROJECT_EXPERIENCE:
            e = self.store.get_experience(memory_id, space_id)
            if e is None or exp.lifecycle(e) == "archived":
                return None
            t = next(
                (
                    x
                    for x in (self.store.get_topic(tid, space_id) for tid in reversed(e.topic_ids))
                    if x is not None
                ),
                None,
            )
            base = self._experience_out(e, True)
            if t is None:  # 关联的主题都删了：只返回经验本身
                return {
                    "project_item_list": [{"item_type": "experience", **base, "space_id": space_id}]
                }
            return {"project_item_list": [self._item("experience", t, base, None)]}
        return None

    def topic_detail(
        self,
        t: Topic,
        query: str | None = None,
        user_id: str = "",
        relativity: float | None = None,
        types: list[str] | None = None,
    ) -> dict[str, Any]:
        """query 为 None：完整返回（get/memory）；否则只带与 query 相关的条目、不带来源（search/memory）。"""
        full = query is None
        decisions = self.store.list_decisions(t.space_id, t.id)
        experiences = [
            e
            for e in self.store.list_experiences(t.space_id)
            if t.id in e.topic_ids and exp.lifecycle(e) != "archived"
        ]  # 11/18 定：待验证的经验也对 Space 所有成员可见，不按调用者过滤
        timeline = list(t.timeline)
        if not full:
            decisions = self._relevant(query, decisions, lambda d: d.index_text)
            experiences = self._relevant(
                query, experiences, lambda e: e.memory_text, weight=lambda e: e.confidence
            )
            timeline = self._relevant(query, timeline, lambda x: x.get("content", ""))
        else:
            decisions.sort(key=lambda d: d.time)
            experiences.sort(key=lambda e: e.confidence, reverse=True)
        if types is not None:  # project_item_types：只带要的那几类条目
            decisions = decisions if "decision" in types else []
            experiences = experiences if "experience" in types else []
            timeline = timeline if "timeline" in types else []
        out = {
            "id": t.id,
            "space_id": t.space_id,
            "domain": t.domain,
            "topic_name": t.name,
            "topic_summary": t.summary,
            "topic_description": t.description,
            "decisions": [self._decision_out(d, full) for d in decisions],
            "experiences": [self._experience_out(e, full) for e in experiences],
            "timeline": [
                {
                    **({"id": x["id"]} if x.get("id") else {}),
                    "content": x.get("content", ""),
                    "time": x.get("time", ""),
                    "user_ids": x.get("user_ids", []),
                }
                for x in sorted(timeline, key=lambda x: x.get("time", ""))
            ],
            "update_time": t.update_time,
        }
        if relativity is not None:
            out["relativity"] = round(relativity, 4)
        if full:
            out["sources"] = t.sources
            out["create_time"] = t.create_time
        return out

    def _relevant(
        self, query: str, items: list, text: Callable, weight: Callable | None = None
    ) -> list:
        return [it for _, it in self._scored(query, items, text, weight)[:MAX_ENTRIES]]

    def _scored(
        self, query: str, items: list, text: Callable, weight: Callable | None = None
    ) -> list[tuple[float, Any]]:
        """条目与 query 的相关度（字面二元组与向量余弦取大，≥REL_MIN），由高到低。"""
        scored = []
        if not items:
            return []
        texts = [text(it) for it in items]
        qv, vecs = None, None
        if self.store.embedder is not None:
            # 查询与条目一次批量算向量（逐条调向量模型，一次检索要调上百次）
            try:
                out = self.store.embedder([query, *texts])
                qv, vecs = out[0], out[1:]
            except Exception:
                qv, vecs = None, None
        for i, it in enumerate(items):
            s = lexical_sim(query, texts[i])
            if qv is not None and vecs is not None:
                with contextlib.suppress(Exception):
                    s = max(s, cosine(qv, vecs[i]))
            if s >= REL_MIN:
                scored.append((s * (weight(it) if weight else 1.0), it))
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored

    @staticmethod
    def _decision_out(d: Decision, full: bool) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": d.id,
            "content": d.content,
            "time": d.time,
            "user_ids": d.user_ids,
            "user_labels": d.user_labels,
        }
        if full:
            out["source"] = d.source.to_json()
        if d.history:
            out["history"] = [
                {
                    "content": h.content,
                    "time": h.time,
                    "user_ids": h.user_ids,
                    "reason": h.reason,
                    **(
                        {"source": h.source.to_json(), "change_source": h.change_source.to_json()}
                        if full
                        else {}
                    ),
                }
                for h in sorted(d.history, key=lambda h: time_key(h.time))
            ]
        if d.conflicts:
            out["conflicts"] = [
                {
                    "content": c.content,
                    "time": c.time,
                    "user_ids": c.user_ids,
                    **({"source": c.source.to_json()} if full else {}),
                }
                for c in d.conflicts
            ]
        return out

    @staticmethod
    def _experience_out(e, full: bool) -> dict[str, Any]:
        out = {
            "id": e.id,
            "content": e.memory_text[:EXP_CONTENT_MAX],
            "time": e.time,
            "user_ids": e.author_ids,
            "task_intent": e.task_intent,
            "exp_status": e.exp_status,
            "confidence": e.confidence,
            "lifecycle": exp.lifecycle(e),
        }
        if full:
            out["card"] = e.card()
            out["version"] = e.version
            out["sources"] = e.sources
        return out

    def list_topics(self, req: Any) -> dict[str, Any]:
        space = self.get_space(req.space_id)
        topics = self.store.list_topics(space.space_id)
        topics = [t for t in topics if _match_filter(t, getattr(req, "filter", None) or {})]
        size = getattr(req, "size", None) or getattr(req, "page_size", None)
        page = getattr(req, "page", None) or 1
        total = len(topics)
        if size:
            topics = topics[(page - 1) * size : page * size]
        return {
            "space_id": space.space_id,
            "total": total,
            "topic_detail_list": [self.topic_detail(t) for t in topics],
        }

    def get_topic(self, memory_id: str) -> dict[str, Any] | None:
        t = self.store.get_topic(memory_id)
        return self.topic_detail(t) if t else None

    def delete(self, req: Any) -> dict[str, Any]:
        ids = list(getattr(req, "memory_ids", None) or [])
        if isinstance(self.store, RelationalProjectView):
            return {
                "space_id": req.space_id,
                "deleted_topic_ids": self.store.delete_topics(req.space_id, ids),
            }
        space = self.get_space(req.space_id)
        topics = self.store.list_topics(space.space_id)
        targets = [t for t in topics if t.id in ids] if ids else topics
        missing = set(ids) - {t.id for t in targets}
        if missing:
            raise LookupError(f"主题不在这个 Space 里：{sorted(missing)}")
        if not ids:
            # 清空：epoch 加 1，清空前受理、还没整理或正在整理的内容都不再写回（PRD）
            space.epoch += 1
            self.store.put_space(space)
            for state in ("open", "pending", "deferred"):
                for e in self.store.episodes(space.space_id, state):
                    e.state = "discarded"
                    self.store.put_episode(e)
        for t in targets:
            self.store.delete_topic(t)
        return {"space_id": space.space_id, "deleted_topic_ids": [t.id for t in targets]}

    def task_status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        task = self.store.get_task(task_id)
        if task is None:
            return None
        # 还留在没整理的段里的本任务消息数，查询时现算（flush 之后自然变 0）
        mine = set(task.message_ids)
        n = 0
        for sid in task.space_ids:
            for state in ("open", "pending", "deferred"):
                for e in self.store.episodes(sid, state):
                    n += len(mine.intersection(e.message_ids))
        task.open_episode_messages = n
        return task.to_api()

    def get_message(
        self, conversation_id: str, space_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        spaces = (
            [space_id]
            if space_id
            else (self.store.get_index(f"conv:{conversation_id}") or {}).get("space_ids", [])
        )
        seen: set[str | tuple] = set()
        out: list[dict[str, Any]] = []
        for sid in spaces:
            for m in self.store.list_messages(sid, conversation_id):
                key = (
                    m.id
                    if isinstance(self.store, RelationalProjectView)
                    else (m.role, m.chat_time, m.text, m.tool_args)
                )
                if key in seen:
                    continue
                seen.add(key)
                out.append(
                    {
                        "message_id": m.id,
                        "role": {"member": "user", "agent": "assistant"}.get(m.role, m.role),
                        "content": m.text,
                        "chat_time": m.chat_time,
                        "role_id": m.user_id,
                        "role_name": m.name,
                        **(
                            {"tool_name": m.tool_name, "tool_args": m.tool_args}
                            if m.role == "tool"
                            else {}
                        ),
                    }
                )
        return out[-limit:] if limit else out


# ═════════════════════════════════ 消息解析 ══════════════════════════════════


def _reject_batch_duplicates(names: list[Any]) -> None:
    """领域批量操作：同一批里出现两次的名称整批失败（PRD 领域管理共同规则）。"""
    seen: set[str] = set()
    dup: list[str] = []
    for n in names:
        key = str(n).strip() if n is not None else ""
        if key in seen and key not in dup:
            dup.append(key)
        seen.add(key)
    if dup:
        raise ValueError(f"同一批里领域重名：{dup}")


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(p.get("text", ""))
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    if isinstance(content, dict):
        return str(content.get("text", ""))
    return "" if content is None else str(content)


_TIME_OPS = {
    "gte": lambda a, b: a >= b,
    "gt": lambda a, b: a > b,
    "lte": lambda a, b: a <= b,
    "lt": lambda a, b: a < b,
    "eq": lambda a, b: a == b,
}


ITEM_TYPES = ("topic", "decision", "experience", "timeline")


def _item_types(req: Any) -> list[str]:
    raw = as_list(getattr(req, "project_item_types", None))
    bad = [x for x in raw if x not in ITEM_TYPES]
    if bad:
        raise ValueError(f"project_item_types 不支持：{bad}，可选 {list(ITEM_TYPES)}")
    return raw or list(ITEM_TYPES)


def _match_filter(t: Topic, flt: dict[str, Any]) -> bool:
    """get/memory 的 filter：`related_id`（来源会话的成员或 Agent）、`create_time` / `update_time`
    （`{"gte": "2026-11-01", "lt": ...}`；只给日期的按 `PROJECT_MEMORY_NAIVE_TZ` 当天 0 点）。"""
    if not isinstance(flt, dict):
        raise ValueError("filter 必须是对象")
    related = flt.get("related_id")
    if isinstance(related, dict):
        related = related.get("contains") or related.get("eq")
    if related is not None:
        if not isinstance(related, str):
            raise ValueError("filter.related_id 只接受单个字符串")
        if related not in t.related_user_ids() and related not in t.related_agent_ids():
            return False
    for field_name in ("create_time", "update_time"):
        cond = flt.get(field_name)
        if cond is None:
            continue
        if not isinstance(cond, dict):
            cond = {"eq": cond}
        value = time_key(ensure_tz(getattr(t, field_name)))
        for op, bound in cond.items():
            if op not in _TIME_OPS:
                raise ValueError(f"filter.{field_name} 不支持 {op}")
            b = str(bound)
            if len(b) == 10:  # 只给日期
                b += "T00:00:00"
            if not _TIME_OPS[op](value, time_key(ensure_tz(b))):
                return False
    return True


def parse_messages(raw: list[Any], user_id: str) -> list[Msg]:
    """把 add/message 的 messages 转成三类消息。

    - user → 成员消息（说话人取 role_id / role_name，没传就用请求的 user_id）；
    - assistant 正文 → Agent 回复；assistant 的 tool_calls → 每个调用一条工具记录；
    - tool → 并进对应 tool_call_id 的工具记录作为返回（找不到就单独一条）。

    chat_time 没带时区时按 `naive_tz()` 补（与没传 chat_time 时取的服务器时间同一套时区）。
    工程层仍应按调用方的时区补齐；这里兜底，避免同一 Space 里带时区与不带时区的时间混用、
    切段相减时报错。
    """

    out: list[Msg] = []
    calls: dict[str, Msg] = {}
    now = now_iso()
    for i, r in enumerate(raw):
        r = dict(r) if isinstance(r, dict) else {"role": "user", "content": str(r)}
        role = r.get("role", "user")
        t = ensure_tz(r.get("chat_time") or now)
        mid = r.get("message_id") or f"m{i + 1:04d}-{new_uuid()[:8]}"
        if role == "user":
            out.append(
                Msg(
                    id=mid,
                    role="member",
                    text=_text(r.get("content")),
                    chat_time=t,
                    user_id=r.get("role_id") or user_id,
                    name=r.get("role_name") or r.get("role_id") or user_id,
                )
            )
        elif role == "assistant":
            body = _text(r.get("content"))
            calls_raw = r.get("tool_calls") or []
            if isinstance(calls_raw, dict):
                calls_raw = [calls_raw]
            for j, c in enumerate(calls_raw):
                fn = (c or {}).get("function") or {}
                tm = Msg(
                    id=(c or {}).get("id") or f"{mid}-call{j + 1}",
                    role="tool",
                    text="",
                    chat_time=t,
                    tool_name=fn.get("name", ""),
                    tool_args=str(fn.get("arguments", "")),
                    tool_call_id=(c or {}).get("id", ""),
                )
                out.append(tm)
                if tm.tool_call_id:
                    calls[tm.tool_call_id] = tm
            notes = r.get("experience_notes") or []
            if body or notes:
                out.append(Msg(id=mid, role="agent", text=body, chat_time=t, notes=list(notes)))
        elif role == "tool":
            cid = r.get("tool_call_id", "")
            if cid in calls:
                calls[cid].text = _text(r.get("content"))
            else:
                out.append(
                    Msg(
                        id=mid,
                        role="tool",
                        text=_text(r.get("content")),
                        chat_time=t,
                        tool_call_id=cid,
                    )
                )
    return out


def stream_owner(space_id: str, conversation_id: str | None) -> str:
    """调度消息的 user_id：一个会话一条流。

    会话 id 常带冒号（如 `claude-code:b-1029`），而调度器的状态键按冒号切分，所以取哈希。
    没有会话 id 的提交自成一段，用 Space 本身。
    """
    if not conversation_id:
        return space_id
    h = hashlib.sha1(conversation_id.encode("utf-8")).hexdigest()[:12]
    return f"{space_id}.{h}"


def _with_context(fn: Callable[[], Any]) -> Callable[[], Any]:
    """把当前的 contextvars（请求上下文、trace id）带进线程池。"""
    import contextvars

    ctx = contextvars.copy_context()
    return lambda: ctx.run(fn)
