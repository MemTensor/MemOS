# -*- coding: utf-8 -*-
"""判定与生成的统一接口：`judge()` / `write()`。

口径（T1 §2.2、经验方案开头）：业务代码只调这两个函数，后端可换——
Jev 官方 API（`jev_api`）、大模型（`llm`）、交付的 Jev（`jev_self`）、本仓主干用的 `mock`。
是非题一律三档「是 / 拿不准 / 否」再用，业务代码不读概率。

主干先只实现 `mock`，其余三种后端骨架在这里留位（TODO），接的时候只改配置不改业务代码。
"""

from __future__ import annotations

import json
import os

from dataclasses import dataclass
from typing import Any, Protocol


BINARY_YES = "yes"
BINARY_UNSURE = "unsure"
BINARY_NO = "no"

BACKEND_ENV = "MEMOS_PROJECT_MEMORY_JUDGE_BACKEND"


# ── 三档 ───────────────────────────────────────────────────────────────────


@dataclass
class Answer:
    """一道是非题的答案。带一句理由，进丢弃清单与 trace。"""

    question: str
    value: str  # yes | unsure | no
    reason: str = ""

    @property
    def is_yes(self) -> bool:
        return self.value == BINARY_YES

    @property
    def is_no(self) -> bool:
        return self.value == BINARY_NO


def answer_from_probability(question: str, p_yes: float, hi: float, lo: float, reason: str = "") -> Answer:
    """把 [0,1] 换成三档。阈值按题分别标定（T1 附录 B.5），默认 0.7 / 0.3。"""
    if p_yes >= hi:
        return Answer(question, BINARY_YES, reason)
    if p_yes <= lo:
        return Answer(question, BINARY_NO, reason)
    return Answer(question, BINARY_UNSURE, reason)


# ── 后端 ───────────────────────────────────────────────────────────────────


class JudgeBackend(Protocol):
    def answer(self, scope: str, payload: dict[str, Any], questions: list[str]) -> dict[str, Answer]:
        """给定一批题与材料，逐题答三档。"""

    def generate(self, scope: str, prompt: str, payload: dict[str, Any]) -> dict[str, Any]:
        """生成类调用：按 scope 的提示词把 payload 写成一个 JSON。"""


class MockJudgeBackend:
    """主干用的后端：替身，答案由调用方在 `payload["_answers"]` 里直接给定。

    这样主干能整条跑通、样例可复现，算法环节本身不必等模型。真实后端只需实现同一接口。
    """

    def answer(self, scope: str, payload: dict[str, Any], questions: list[str]) -> dict[str, Answer]:
        preset = payload.get("_answers") or {}
        out: dict[str, Answer] = {}
        for q in questions:
            if isinstance(preset, str):  # 单题直给
                out[q] = Answer(q, preset, "")
                continue
            v = preset.get(q, BINARY_UNSURE)
            if isinstance(v, dict):
                out[q] = Answer(q, v.get("value", BINARY_UNSURE), v.get("reason", ""))
            else:
                out[q] = Answer(q, v, "")
        return out

    def generate(self, scope: str, prompt: str, payload: dict[str, Any]) -> dict[str, Any]:
        preset = payload.get("_generated")
        if preset is None:
            raise RuntimeError(
                f"mock 后端没有给 {scope} 的生成结果：把期望结果放进 payload['_generated']"
            )
        return json.loads(json.dumps(preset))


class NotImplementedBackend:
    """占位：Jev 官方 API / 大模型 / 交付的 Jev。接口已定，接的时候照 MockJudgeBackend 的形状实现。"""

    def __init__(self, kind: str):
        self.kind = kind

    def answer(self, scope: str, payload: dict[str, Any], questions: list[str]) -> dict[str, Answer]:
        raise NotImplementedError(
            f"判定后端 {self.kind} 还没接：业务代码不用改，实现 JudgeBackend 的 answer/generate 即可"
        )

    def generate(self, scope: str, prompt: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError(
            f"判定后端 {self.kind} 还没接：业务代码不用改，实现 JudgeBackend 的 answer/generate 即可"
        )


_BACKENDS: dict[str, JudgeBackend] = {}


def get_backend(kind: str | None = None) -> JudgeBackend:
    kind = kind or os.getenv(BACKEND_ENV, "mock")
    if kind not in _BACKENDS:
        if kind == "mock":
            _BACKENDS[kind] = MockJudgeBackend()
        else:
            _BACKENDS[kind] = NotImplementedBackend(kind)
    return _BACKENDS[kind]


def set_backend(kind: str, backend: JudgeBackend) -> None:
    """替换后端（测试或接真模型时用）。"""
    _BACKENDS[kind] = backend


# ── 业务代码只调这两个 ─────────────────────────────────────────────────────


def judge(scope: str, payload: dict[str, Any], questions: list[str], kind: str | None = None) -> dict[str, Answer]:
    """答一批是非题。scope 是调用点编号，例如 `dec.gate`、`dec.same_problem`、`exp.filter`。"""
    return get_backend(kind).answer(scope, payload, questions)


def write(scope: str, prompt: str, payload: dict[str, Any], kind: str | None = None) -> dict[str, Any]:
    """生成一次结构化结果。scope 例如 `dec.extract`、`exp.extract`、`exp.merge`。"""
    return get_backend(kind).generate(scope, prompt, payload)


def one(answers: dict[str, Answer], question: str) -> Answer:
    return answers.get(question) or Answer(question, BINARY_UNSURE, "题没答")
