"""判定与生成的统一接口：`judge()` / `write()`，后端可换。

口径（T1 §2.2）：业务代码只调这两个函数——
- `judge(scope, state, questions)`：答一批是非题（noul）或选择题（choice）；是非题统一换成三档「是 / 拿不准 / 否」；
- `write(scope, prompt, inputs)`：按提示词生成一个 JSON。

后端：
- `llm`（默认）：MemOS 已配置的大模型（插件上下文里的 `llm`，即 `BaseLLM.generate(messages)`）。
  判别题用 `pm-judge-llm-v0.1` 包装成一次调用，只答 yes / no / unsure，直接对应三档；
- `jev_api`、`jev_self`：Jev 官方 API / 交付的 Jev，接口已定，还没接；
- 测试里用同一个 `LLMBackend` 配一个假的 llm，走的是真实的提示词拼装与 JSON 解析。

换后端只改环境变量 `MEMOS_PROJECT_MEMORY_JUDGE_BACKEND`，业务代码不动。
"""

from __future__ import annotations

import json
import logging
import os
import re

from dataclasses import dataclass
from typing import Any, Protocol

from memos.llms.usage import CHAT, expect_usage

from .prompts import JUDGE_LLM


logger = logging.getLogger(__name__)

YES, UNSURE, NO = "yes", "unsure", "no"
BACKEND_ENV = "MEMOS_PROJECT_MEMORY_JUDGE_BACKEND"


@dataclass
class Answer:
    question: str
    value: str  # noul: yes|no|unsure；choice: 选项 id
    reason: str = ""

    @property
    def is_yes(self) -> bool:
        return self.value == YES


class ModelError(RuntimeError):
    """模型调用失败或输出解析不了。调度层据此把任务记为失败、可重试。"""


class Backend(Protocol):
    def answer(
        self, scope: str, state: dict[str, Any], questions: dict[str, Any]
    ) -> dict[str, Answer]: ...

    def generate(
        self, scope: str, prompt: str, inputs: Any, placeholders: dict[str, str] | None = None
    ) -> dict[str, Any]: ...


# ── 解析 ───────────────────────────────────────────────────────────────────


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def parse_json(text: str) -> dict[str, Any]:
    """从模型输出里取出第一个 JSON 对象。容忍代码围栏与前后多余文字。"""
    if not text:
        raise ModelError("模型输出为空")
    body = _FENCE.sub("", text.strip())
    try:
        out = json.loads(body)
        if isinstance(out, dict):
            return out
    except json.JSONDecodeError:
        pass
    start = body.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(body)):
            if body[i] == "{":
                depth += 1
            elif body[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        out = json.loads(body[start : i + 1])
                        if isinstance(out, dict):
                            return out
                    except json.JSONDecodeError:
                        break
        start = body.find("{", start + 1)
    raise ModelError(f"模型输出不是 JSON：{text[:200]}")


def split_prompt(prompt: str) -> tuple[str, str]:
    """「[系统] … [用户] …」两段式提示词拆成 system / user 两条消息；没有标记就整段作 user。"""
    if "[用户]" in prompt:
        sys_part, user_part = prompt.split("[用户]", 1)
        return sys_part.replace("[系统]", "", 1).strip(), user_part.strip()
    return "", prompt.strip()


def fill(prompt: str, placeholders: dict[str, str]) -> str:
    """只做字面替换（提示词里有 JSON 样例，不能用 str.format）。"""
    out = prompt
    for k, v in placeholders.items():
        out = out.replace(k, v)
    return out


def to_json_text(obj: Any) -> str:
    return obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=1)


def normalize_noul(v: Any) -> str:
    if isinstance(v, dict):
        v = v.get("noul", v.get("value"))
    if isinstance(v, int | float) and not isinstance(v, bool):
        return (
            YES if v >= 0.7 else NO if v <= 0.3 else UNSURE
        )  # Jev 类后端给概率时的初值（T1 附录 B.5）
    s = str(v or "").strip().lower()
    if s in ("yes", "是", "true"):
        return YES
    if s in ("no", "否", "false"):
        return NO
    return UNSURE


# ── 后端 ───────────────────────────────────────────────────────────────────


class LLMBackend:
    """用 MemOS 已配置的大模型答判别题、做生成。"""

    def __init__(self, llm: Any, retries: int = 1):
        self.llm = llm
        self.retries = retries

    def _call(self, scope: str, system: str, user: str) -> dict[str, Any]:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})
        last: Exception | None = None
        model = getattr(getattr(self.llm, "config", None), "model_name_or_path", None)
        for _ in range(self.retries + 1):
            try:
                # Backends that do not meter provider usage still count as a usage-less call.
                with expect_usage(CHAT, model if isinstance(model, str) else None):
                    raw = self.llm.generate(messages)
                return parse_json(raw)
            except Exception as e:
                last = e
                logger.warning("[ProjectMemory] %s 调用失败，重试：%s", scope, e)
        raise ModelError(f"{scope}: {last}")

    def answer(
        self, scope: str, state: dict[str, Any], questions: dict[str, Any]
    ) -> dict[str, Answer]:
        system, user = split_prompt(
            fill(
                JUDGE_LLM, {"{state}": to_json_text(state), "{questions}": to_json_text(questions)}
            )
        )
        out = self._call(scope, system, user)
        answers = out.get("answers") or {}
        result: dict[str, Answer] = {}
        for q, spec in questions.items():
            got = answers.get(q)
            if spec.get("type") == "choice":
                val = got.get("choice") if isinstance(got, dict) else got
                if val not in (spec.get("criteria") or {}):
                    val = ""
                result[q] = Answer(q, str(val or ""))
            else:
                result[q] = Answer(q, normalize_noul(got))
        return result

    def generate(
        self, scope: str, prompt: str, inputs: Any, placeholders: dict[str, str] | None = None
    ) -> dict[str, Any]:
        ph = dict(placeholders or {})
        if inputs is not None:
            ph.setdefault("{inputs}", to_json_text(inputs))
        system, user = split_prompt(fill(prompt, ph))
        return self._call(scope, system, user)


class NotWiredBackend:
    """Jev 官方 API / 交付的 Jev：接口已定，还没接。"""

    def __init__(self, kind: str):
        self.kind = kind

    def answer(self, scope, state, questions):
        raise ModelError(f"判定后端 {self.kind} 还没接；把 {BACKEND_ENV} 设为 llm")

    def generate(self, scope, prompt, inputs, placeholders=None):
        raise ModelError(f"判定后端 {self.kind} 不做生成；生成固定走 llm")


class ModelHub:
    """按配置给每个调用点选后端。判别与生成可以分开配（Jev 只答判别题）。

    - `llm`：生成（抽取、更新、合并、归主题）与默认判别；
    - `judge_llm`：判别题专用，可换更便宜的模型；不传就用 `llm`；
    - `graph_db`：存储支持条件写（`supports_cas`）时，ModelError 之外的写冲突由服务层重试。
    """

    def __init__(
        self,
        llm: Any | None = None,
        judge_backend: str | None = None,
        judge_llm: Any | None = None,
        graph_db: Any | None = None,
    ):
        self.graph_db = graph_db
        self.llm_backend = LLMBackend(llm) if llm is not None else None
        judge_source = judge_llm if judge_llm is not None else llm
        judge_llm_backend = LLMBackend(judge_source) if judge_source is not None else None
        kind = judge_backend or os.getenv(BACKEND_ENV, "llm")
        self.judge_backend: Any = judge_llm_backend if kind == "llm" else NotWiredBackend(kind)

    def _require(self, b: Any) -> Any:
        if b is None:
            raise ModelError("项目记忆没有可用的大模型：插件上下文里没有 llm")
        return b

    def judge(
        self, scope: str, state: dict[str, Any], questions: dict[str, Any]
    ) -> dict[str, Answer]:
        return self._require(self.judge_backend).answer(scope, state, questions)

    @property
    def supports_cas(self) -> bool:
        return bool(getattr(self.graph_db, "supports_cas", False))

    def write(
        self,
        scope: str,
        prompt: str,
        inputs: Any | None = None,
        placeholders: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._require(self.llm_backend).generate(scope, prompt, inputs, placeholders)


def one(answers: dict[str, Answer], q: str) -> Answer:
    return answers.get(q) or Answer(q, UNSURE)
