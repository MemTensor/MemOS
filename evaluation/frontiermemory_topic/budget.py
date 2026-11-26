"""Meter each DeepSeek wire attempt in the local FrontierMemory replay."""

from __future__ import annotations

import fcntl
import json
import logging
import math
import os

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import httpx
import openai

from dotenv import dotenv_values

from memos.configs.llm import OpenAILLMConfig
from memos.configs.llm_rate_limit import LLMRateLimitConfig
from memos.llms.openai import OpenAILLM


if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path
    from typing import TextIO

    from memos.types import MessageList


MODEL = "deepseek-v4.1-flash-1017"
RESPONSE_MODELS = frozenset({MODEL, "deepseek-v4-1-flash-261017", "deepseek-flash"})
MAX_OUTPUT = 4096
# Positive units are integer nanodollars at the peak, uncached Flash rates.
INPUT_PRICE = 300
OUTPUT_PRICE = 1200
NANO_PER_USD = 1_000_000_000
CHAT_OVERHEAD = 512
_SCOPE: ContextVar[str] = ContextVar("frontiermemory_budget_scope", default="untagged")


class BudgetStopError(RuntimeError):
    """Stop this replay before another DeepSeek wire attempt."""


class GatewayRequestError(RuntimeError):
    """A wire attempt failed without yielding a usable completion."""


@contextmanager
def budget_scope(scope: str) -> Iterator[None]:
    """Tag nested billable requests with their replay operation."""
    token = _SCOPE.set(scope)
    try:
        yield
    finally:
        _SCOPE.reset(token)


def _estimate(input_tokens: int, output_tokens: int) -> int:
    return input_tokens * INPUT_PRICE + output_tokens * OUTPUT_PRICE


def _token_count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _usage(body: dict) -> dict[str, int] | None:
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None
    input_tokens = _token_count(usage.get("prompt_tokens"))
    output_tokens = _token_count(usage.get("completion_tokens"))
    if input_tokens is None or output_tokens is None:
        return None
    details = usage.get("prompt_tokens_details")
    cached = _token_count(usage.get("prompt_cache_hit_tokens"))
    if cached is None and isinstance(details, dict):
        cached = _token_count(details.get("cached_tokens"))
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": min(input_tokens, cached or 0),
        "output_tokens": output_tokens,
    }


class UsageLedger:
    """An append-only JSONL ledger, locked across readers and billable attempts."""

    def __init__(self, path: Path, cap_usd: float) -> None:
        if not math.isfinite(cap_usd) or not 0 < cap_usd <= 10:
            raise ValueError("DeepSeek budget must be greater than $0 and at most $10")
        self.path = path
        self.cap = math.floor(cap_usd * NANO_PER_USD)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def _locked(self) -> Iterator[TextIO]:
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a+", encoding="utf-8") as ledger:
            fcntl.flock(ledger.fileno(), fcntl.LOCK_EX)
            ledger.seek(0)
            yield ledger

    @staticmethod
    def _write(ledger: TextIO, **event: Any) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        ledger.write(json.dumps({"at": timestamp, **event}, separators=(",", ":")) + "\n")
        ledger.flush()
        os.fsync(ledger.fileno())

    @staticmethod
    def _read(ledger: TextIO) -> tuple[dict[str, dict], str | None]:
        requests = {}
        stopped = None
        try:
            for line in ledger:
                item = json.loads(line)
                if item["event"] == "reserve":
                    if item["id"] in requests:
                        raise ValueError("duplicate reservation")
                    requests[item["id"]] = item
                elif item["event"] == "settle":
                    request = requests[item["id"]]
                    if request.get("outcome") is not None:
                        raise ValueError("duplicate settlement")
                    request.update(
                        {key: val for key, val in item.items() if key not in {"at", "event", "id"}}
                    )
                elif item["event"] == "stop":
                    stopped = item["reason"]
                else:
                    raise ValueError("invalid event")
        except (TypeError, KeyError, ValueError):
            raise BudgetStopError("DeepSeek budget ledger is unreadable") from None
        return requests, stopped

    def ensure_open(self) -> None:
        """Raise when the ledger has halted or reached the cap."""
        with self._locked() as ledger:
            requests, stopped = self._read(ledger)
        if stopped:
            raise BudgetStopError(stopped)
        if sum(item["charge_nano_usd"] for item in requests.values()) >= self.cap:
            raise BudgetStopError("DeepSeek budget exhausted")

    def reserve(self, input_bound: int, max_output: int) -> tuple[str, int]:
        """Durably reserve an upper estimate before sending a request."""
        bound = _estimate(input_bound, max_output)
        with self._locked() as ledger:
            requests, stopped = self._read(ledger)
            if stopped:
                raise BudgetStopError(stopped)
            spent = sum(item["charge_nano_usd"] for item in requests.values())
            if spent + bound > self.cap:
                reason = "DeepSeek budget would be exceeded by the next request"
                self._write(ledger, event="stop", reason=reason)
                raise BudgetStopError(reason)
            call_id = uuid4().hex
            self._write(
                ledger,
                event="reserve",
                id=call_id,
                scope=_SCOPE.get(),
                requested_model=MODEL,
                input_bound=input_bound,
                max_output_tokens=max_output,
                charge_nano_usd=bound,
            )
        return call_id, bound

    def settle(
        self,
        call_id: str,
        reserved: int,
        outcome: str,
        *,
        model: str | None = None,
        usage: dict[str, int] | None = None,
        stop_reason: str | None = None,
    ) -> None:
        """Replace a reservation with peak-rate measured usage when available."""
        charge = _estimate(usage["input_tokens"], usage["output_tokens"]) if usage else reserved
        if charge > reserved:
            stop_reason = "DeepSeek usage exceeded its request reservation"
        with self._locked() as ledger:
            self._write(
                ledger,
                event="settle",
                id=call_id,
                returned_model=model,
                outcome=outcome,
                usage=usage,
                charge_nano_usd=charge,
            )
            if stop_reason:
                self._write(ledger, event="stop", reason=stop_reason)
        if stop_reason:
            raise BudgetStopError(stop_reason)

    def summary(self) -> dict[str, Any]:
        """Return a conservative total and per-operation accounting."""
        with self._locked() as ledger:
            requests, stopped = self._read(ledger)

        def aggregate(rows: list[dict]) -> dict[str, int | float]:
            measured = [row["usage"] for row in rows if row.get("usage") is not None]
            return {
                "requests": len(rows),
                "recorded_usage": len(measured),
                "requests_without_usage": len(rows) - len(measured),
                "input_tokens": sum(row["input_tokens"] for row in measured),
                "cached_input_tokens": sum(row["cached_input_tokens"] for row in measured),
                "output_tokens": sum(row["output_tokens"] for row in measured),
                "estimated_usd": sum(row["charge_nano_usd"] for row in rows) / NANO_PER_USD,
            }

        by_scope: dict[str, list[dict]] = {}
        for row in requests.values():
            by_scope.setdefault(row["scope"], []).append(row)
        return {
            **aggregate(list(requests.values())),
            "by_scope": {scope: aggregate(rows) for scope, rows in sorted(by_scope.items())},
            "cap_usd": self.cap / NANO_PER_USD,
            "stop_reason": stopped,
        }


class _MeteredTransport(httpx.BaseTransport):
    def __init__(
        self, target: httpx.URL, ledger: UsageLedger, upstream: httpx.BaseTransport
    ) -> None:
        self.target = target
        self.ledger = ledger
        self.upstream = upstream

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Reserve the attempt at the HTTP boundary after checking its model and bounds."""
        raw = request.read()
        payload = json.loads(raw)
        max_output = payload.get("max_tokens")
        if (
            request.method != "POST"
            or request.url != self.target
            or payload.get("model") != MODEL
            or _token_count(max_output) is None
            or not 0 < max_output <= MAX_OUTPUT
            or payload.get("thinking") != {"type": "disabled"}
            or payload.get("temperature") != 0
            or set(payload)
            - {"model", "messages", "max_tokens", "thinking", "temperature", "top_p"}
        ):
            raise BudgetStopError("Unsupported DeepSeek request for the pilot")
        call_id, reserved = self.ledger.reserve(len(raw) + CHAT_OVERHEAD, max_output)
        try:
            response = self.upstream.handle_request(request)
            response.read()
        except httpx.HTTPError:
            self.ledger.settle(call_id, reserved, "transport_error")
            raise GatewayRequestError("DeepSeek gateway transport failed") from None

        status = response.status_code
        if not response.is_success:
            response.close()
            fatal = status in {301, 302, 303, 307, 308, 401, 402, 403, 404}
            reason = f"DeepSeek gateway returned HTTP {status}"
            self.ledger.settle(
                call_id, reserved, f"http_{status}", stop_reason=reason if fatal else None
            )
            raise GatewayRequestError(reason)
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            response.close()
            self.ledger.settle(call_id, reserved, "invalid_json")
            raise GatewayRequestError("DeepSeek gateway returned an invalid completion body")
        model = body.get("model")
        if not isinstance(model, str) or model not in RESPONSE_MODELS:
            response.close()
            self.ledger.settle(
                call_id,
                reserved,
                "model_mismatch",
                stop_reason="DeepSeek gateway returned a different or unidentified model",
            )
        self.ledger.settle(call_id, reserved, "ok", model=model, usage=_usage(body))
        return response

    def close(self) -> None:
        """Close the underlying HTTP client resources."""
        self.upstream.close()


class BudgetedOpenAILLM(OpenAILLM):
    """Use the normal OpenAI prompt/response path with a metered transport."""

    def __init__(
        self, config: OpenAILLMConfig, ledger: UsageLedger, transport: httpx.BaseTransport
    ) -> None:
        super().__init__(config)
        self.ledger = ledger
        self.client.close()
        self.client = openai.OpenAI(
            api_key=config.api_key,
            base_url=config.api_base,
            max_retries=0,
            http_client=httpx.Client(
                transport=transport,
                follow_redirects=False,
                timeout=120.0,
            ),
        )

    def generate(self, messages: MessageList, **kwargs: Any) -> str:
        """Surface safe ledger and transport errors through the OpenAI SDK boundary."""
        self.ledger.ensure_open()
        try:
            return super().generate(messages, **kwargs)
        except openai.APIError as exc:
            if isinstance(exc.__cause__, BudgetStopError | GatewayRequestError):
                raise exc.__cause__ from None
            raise GatewayRequestError("DeepSeek gateway completion failed") from None


def build_budgeted_llm(
    profile_path: Path,
    ledger_path: Path,
    *,
    cap_usd: float = 1.0,
    transport: httpx.BaseTransport | None = None,
) -> BudgetedOpenAILLM:
    """Load the existing DeepSeek profile and make every chat attempt budgeted."""
    profile = dotenv_values(profile_path, interpolate=False)
    if profile.get("MODEL") != MODEL:
        raise ValueError("The DeepSeek profile must pin the expected Flash model")
    api_base = (profile.get("OPENAI_API_BASE") or "").rstrip("/")
    api_key = profile.get("OPENAI_API_KEY") or ""
    base_url = httpx.URL(api_base)
    if (
        base_url.scheme != "https"
        or not base_url.host
        or base_url.userinfo
        or base_url.query
        or base_url.fragment
        or not api_key
    ):
        raise ValueError("The DeepSeek profile requires an HTTPS gateway and an API key")
    config = OpenAILLMConfig(
        model_name_or_path=MODEL,
        api_key=api_key,
        api_base=api_base,
        temperature=0,
        max_tokens=MAX_OUTPUT,
        top_p=1.0,
        remove_think_prefix=True,
        rate_limit=LLMRateLimitConfig(enabled=False),
        extra_body={"thinking": {"type": "disabled"}},
    )
    ledger = UsageLedger(ledger_path, cap_usd)
    target = httpx.URL(f"{api_base}/chat/completions")
    # The product client can log prompt and response bodies at INFO.
    logging.getLogger("memos.llms.openai").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)
    upstream = transport if transport is not None else httpx.HTTPTransport(retries=0)
    return BudgetedOpenAILLM(config, ledger, _MeteredTransport(target, ledger, upstream))
