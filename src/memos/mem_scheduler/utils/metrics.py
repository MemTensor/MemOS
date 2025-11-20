# metrics.py
from __future__ import annotations

import threading
import time

from dataclasses import dataclass, field

from memos.log import get_logger


# ==== global window config ====
WINDOW_SEC = 120  # 2 minutes sliding window

logger = get_logger(__name__)


# ---------- O(1) EWMA ----------
class Ewma:
    """
    Time-decayed EWMA:
    """

    __slots__ = ("alpha", "last_ts", "tau", "value")

    def __init__(self, alpha: float = 0.3, tau: float = WINDOW_SEC):
        self.alpha = alpha
        self.value = 0.0
        self.last_ts: float = time.time()
        self.tau = max(1e-6, float(tau))

    def _decay_to(self, now: float | None = None):
        now = time.time() if now is None else now
        dt = max(0.0, now - self.last_ts)
        if dt <= 0:
            return
        from math import exp

        self.value *= exp(-dt / self.tau)
        self.last_ts = now

    def update(self, instant: float, now: float | None = None):
        self._decay_to(now)
        self.value = self.alpha * instant + (1 - self.alpha) * self.value

    def value_at(self, now: float | None = None) -> float:
        now = time.time() if now is None else now
        dt = max(0.0, now - self.last_ts)
        if dt <= 0:
            return self.value
        from math import exp

        return self.value * exp(-dt / self.tau)


# ---------- approximate P95(Reservoir sample) ----------
class ReservoirP95:
    __slots__ = ("_i", "buf", "k", "n", "window")

    def __init__(self, k: int = 512, window: float = WINDOW_SEC):
        self.k = k
        self.buf: list[tuple[float, float]] = []  # (value, ts)
        self.n = 0
        self._i = 0
        self.window = float(window)

    def _gc(self, now: float):
        win_start = now - self.window
        self.buf = [p for p in self.buf if p[1] >= win_start]
        if self.buf:
            self._i %= len(self.buf)
        else:
            self._i = 0

    def add(self, x: float, now: float | None = None):
        now = time.time() if now is None else now
        self._gc(now)
        self.n += 1
        if len(self.buf) < self.k:
            self.buf.append((x, now))
            return
        self.buf[self._i] = (x, now)
        self._i = (self._i + 1) % self.k

    def p95(self, now: float | None = None) -> float:
        now = time.time() if now is None else now
        self._gc(now)
        if not self.buf:
            return 0.0
        arr = sorted(v for v, _ in self.buf)
        idx = int(0.95 * (len(arr) - 1))
        return arr[idx]


# ---------- Space-Saving Top-K ----------
class SpaceSaving:
    """only topK:add(key) O(1),query topk O(K log K)"""

    def __init__(self, k: int = 100):
        self.k = k
        self.cnt: dict[str, int] = {}

    def add(self, key: str):
        if key in self.cnt:
            self.cnt[key] += 1
            return
        if len(self.cnt) < self.k:
            self.cnt[key] = 1
            return
        victim = min(self.cnt, key=self.cnt.get)
        self.cnt[key] = self.cnt.pop(victim) + 1

    def topk(self) -> list[tuple[str, int]]:
        return sorted(self.cnt.items(), key=lambda kv: kv[1], reverse=True)


@dataclass
class KeyStats:
    backlog: int = 0
    lambda_ewma: Ewma = field(default_factory=lambda: Ewma(0.3, WINDOW_SEC))
    mu_ewma: Ewma = field(default_factory=lambda: Ewma(0.3, WINDOW_SEC))
    wait_p95: ReservoirP95 = field(default_factory=lambda: ReservoirP95(512, WINDOW_SEC))
    last_ts: float = field(default_factory=time.time)
    # last event timestamps for rate estimation
    last_enqueue_ts: float | None = None
    last_done_ts: float | None = None

    def snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        lam = self.lambda_ewma.value_at(now)
        mu = self.mu_ewma.value_at(now)
        delta = mu - lam
        eta = float("inf") if delta <= 1e-9 else self.backlog / delta
        return {
            "backlog": self.backlog,
            "lambda": round(lam, 3),
            "mu": round(mu, 3),
            "delta": round(delta, 3),
            "eta_sec": None if eta == float("inf") else round(eta, 1),
            "wait_p95_sec": round(self.wait_p95.p95(now), 3),
        }


class MetricsRegistry:
    """
    metrics:
      - 1st phase:label(must)
      - 2nd phase:labelXmem_cube_id(only Top-K)
      - on_enqueue(label, mem_cube_id)
      - on_start(label, mem_cube_id, wait_sec)
      - on_done(label, mem_cube_id)
    """

    def __init__(self, topk_per_label: int = 50):
        self._lock = threading.RLock()
        self._label_stats: dict[str, KeyStats] = {}
        self._label_topk: dict[str, SpaceSaving] = {}
        self._detail_stats: dict[tuple[str, str], KeyStats] = {}
        self._topk_per_label = topk_per_label

    # ---------- helpers ----------
    def _get_label(self, label: str) -> KeyStats:
        if label not in self._label_stats:
            self._label_stats[label] = KeyStats()
            self._label_topk[label] = SpaceSaving(self._topk_per_label)
        return self._label_stats[label]

    def _get_detail(self, label: str, mem_cube_id: str) -> KeyStats | None:
        # 只有 Top-K 的 mem_cube_id 才建细粒度 key
        ss = self._label_topk[label]
        if mem_cube_id in ss.cnt or len(ss.cnt) < ss.k:
            key = (label, mem_cube_id)
            if key not in self._detail_stats:
                self._detail_stats[key] = KeyStats()
            return self._detail_stats[key]
        return None

    # ---------- events ----------
    def on_enqueue(
        self, label: str, mem_cube_id: str, inst_rate: float = 1.0, now: float | None = None
    ):
        with self._lock:
            now = time.time() if now is None else now
            ls = self._get_label(label)
            # derive instantaneous arrival rate from inter-arrival time (events/sec)
            prev_ts = ls.last_enqueue_ts
            dt = (now - prev_ts) if prev_ts is not None else None
            inst_rate = (1.0 / max(1e-3, dt)) if dt is not None else 0.0  # first sample: no spike
            ls.last_enqueue_ts = now
            ls.backlog += 1
            ls.lambda_ewma.update(inst_rate, now)
            self._label_topk[label].add(mem_cube_id)
            ds = self._get_detail(label, mem_cube_id)
            if ds:
                prev_ts_d = ds.last_enqueue_ts
                dt_d = (now - prev_ts_d) if prev_ts_d is not None else None
                inst_rate_d = (1.0 / max(1e-3, dt_d)) if dt_d is not None else 0.0
                ds.last_enqueue_ts = now
                ds.backlog += 1
                ds.lambda_ewma.update(inst_rate_d, now)

    def on_start(self, label: str, mem_cube_id: str, wait_sec: float, now: float | None = None):
        with self._lock:
            now = time.time() if now is None else now
            ls = self._get_label(label)
            ls.wait_p95.add(wait_sec, now)
            ds = self._detail_stats.get((label, mem_cube_id))
            if ds:
                ds.wait_p95.add(wait_sec, now)

    def on_done(
        self, label: str, mem_cube_id: str, inst_rate: float = 1.0, now: float | None = None
    ):
        with self._lock:
            now = time.time() if now is None else now
            ls = self._get_label(label)
            # derive instantaneous service rate from inter-completion time (events/sec)
            prev_ts = ls.last_done_ts
            dt = (now - prev_ts) if prev_ts is not None else None
            inst_rate = (1.0 / max(1e-3, dt)) if dt is not None else 0.0
            ls.last_done_ts = now
            if ls.backlog > 0:
                ls.backlog -= 1
            ls.mu_ewma.update(inst_rate, now)
            ds = self._detail_stats.get((label, mem_cube_id))
            if ds:
                prev_ts_d = ds.last_done_ts
                dt_d = (now - prev_ts_d) if prev_ts_d is not None else None
                inst_rate_d = (1.0 / max(1e-3, dt_d)) if dt_d is not None else 0.0
                ds.last_done_ts = now
                if ds.backlog > 0:
                    ds.backlog -= 1
                ds.mu_ewma.update(inst_rate_d, now)

    # ---------- snapshots ----------
    def snapshot(self) -> dict:
        with self._lock:
            now = time.time()
            by_label = {lbl: ks.snapshot(now) for lbl, ks in self._label_stats.items()}
            heavy = {lbl: self._label_topk[lbl].topk() for lbl in self._label_topk}
            details = {}
            for (lbl, cube), ks in self._detail_stats.items():
                details.setdefault(lbl, {})[cube] = ks.snapshot(now)
            return {"by_label": by_label, "heavy": heavy, "details": details}
