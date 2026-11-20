"""按键加锁：项目记忆里所有需要串行的临界区都走这里。

为什么要有这一层：整理一个段会经历几次大模型调用，不同会话、不同主题的段之间
没有共享状态，可以并行；只有「同一段的状态」「同一主题的内容」「同一个 Space 的
主题列表」「同一个 Space 的经验卡」这几处需要串行。

默认实现是进程内的键级可重入锁，单进程（本地 docker、一个 uvicorn worker）就是
正确的。多副本或多 worker 时，进程内的锁跨不出机器，工程注册单实现钩子
`H.PROJECT_MEMORY_LOCK`（参数 `key`），返回一个上下文管理器：进入时拿到锁、退出时释放
（比如企业版现成的 Redis 锁 `SET NX EX`）。注册了就用它，没注册用进程内锁。
分布式锁要设过期时间时，按「一段整理里最长的一次大模型调用」留余量；万一锁先过期，
决策与经验的写回还有 rev 条件写兜底（库支持时）。

锁只有两层：会话锁在最外层，其余的锁在会话锁里一次只拿一把、用完就放，不互相嵌套；
不同会话的锁也从不同时持有。所以不会死锁。键的命名：
- `conv:{space}:{conversation}`：一个会话开着的段（切段、关段、写段）。
- `topic:{space}:{topic}`：一个主题的内容（摘要、时间线、决策）。
- `topics:{space}`：这个 Space 的主题列表（用于「新建主题前复核」）。
- `exp:{space}`：这个 Space 的经验卡召回与合并。
- `task:{task}`：任务记录的累加。
"""

from __future__ import annotations

import contextlib
import threading

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable, Iterator


def conv_key(space_id: str, conversation_id: str) -> str:
    """一个会话开着的段。"""
    return f"conv:{space_id}:{conversation_id}"


def topic_key(space_id: str, topic_id: str) -> str:
    """一个主题的内容。"""
    return f"topic:{space_id}:{topic_id}"


def topics_key(space_id: str) -> str:
    """这个 Space 的主题列表（新建主题前复核用）。"""
    return f"topics:{space_id}"


def exp_key(space_id: str) -> str:
    """这个 Space 的经验卡。"""
    return f"exp:{space_id}"


def task_key(task_id: str) -> str:
    """一个任务的记录（多次整理会累加到同一条）。"""
    return f"task:{task_id}"


class InProcessLocks:
    """进程内按键可重入锁。同一线程重复获取同一个键不会自锁。"""

    def __init__(self) -> None:
        self._locks: dict[str, threading.RLock] = {}
        self._guard = threading.Lock()

    def __call__(self, key: str) -> contextlib.AbstractContextManager:
        with self._guard:
            lock = self._locks.setdefault(key, threading.RLock())
        return lock


def make_lock(lock_factory: Callable[[str], Any] | None) -> Callable[[str], Any]:
    """统一成一个 `key -> 上下文管理器` 的可调用对象。"""
    if lock_factory is None:
        return InProcessLocks()
    return lock_factory


class NullLock:
    """不加锁（只在明确知道单线程时用；测试替身用）。"""

    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: Any) -> None:
        return None


@contextlib.contextmanager
def locked(lock: Callable[[str], Any], key: str) -> Iterator[None]:
    """拿锁的简写；`lock` 是 `key -> 上下文管理器` 的可调用对象。"""
    with lock(key):
        yield
