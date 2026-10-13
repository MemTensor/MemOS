import json
import re

from memos import log
from memos.exceptions import LLMResponseParseError


logger = log.get_logger(__name__)

try:
    import tiktoken

    try:
        _ENC = tiktoken.encoding_for_model("gpt-4o-mini")
    except Exception:
        _ENC = tiktoken.get_encoding("cl100k_base")

    def count_tokens_text(s: str) -> int:
        return len(_ENC.encode(s or "", disallowed_special=()))
except Exception:
    # Heuristic fallback: zh chars ~1 token, others ~1 token per ~4 chars
    def count_tokens_text(s: str) -> int:
        if not s:
            return 0
        zh_chars = re.findall(r"[\u4e00-\u9fff]", s)
        zh = len(zh_chars)
        rest = len(s) - zh
        return zh + max(1, rest // 4)


def derive_key(text: str, max_len: int = 80) -> str:
    """default key when without LLM: first max_len words"""
    if not text:
        return ""
    sent = re.split(r"[。！？!?]\s*|\n", text.strip())[0]
    return (sent[:max_len]).strip()


def parse_json_result(response_text: str) -> dict:
    """Parse a JSON object out of an LLM response.

    Returns the parsed ``dict`` when the response contains a parseable JSON
    object (including a literal ``{}``). Raises ``LLMResponseParseError``
    on any other input so callers can distinguish "the model produced no
    memories" from "the model produced output we couldn't parse". Issue
    #2456.
    """
    raw = response_text or ""
    s = raw.strip()

    if not s:
        raise LLMResponseParseError("LLM response was empty")

    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, flags=re.IGNORECASE)
    s = (m.group(1) if m else s.replace("```", "")).strip()

    i = s.find("{")
    if i == -1:
        raise LLMResponseParseError(f"No JSON object found in LLM response: tail={raw[-200:]!r}")
    s = s[i:].strip()

    last_err: json.JSONDecodeError | None = None

    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        last_err = e

    j = max(s.rfind("}"), s.rfind("]"))
    if j != -1:
        try:
            return json.loads(s[: j + 1])
        except json.JSONDecodeError as e:
            last_err = e

    def _cheap_close(t: str) -> str:
        t += "}" * max(0, t.count("{") - t.count("}"))
        t += "]" * max(0, t.count("[") - t.count("]"))
        return t

    t = _cheap_close(s)
    try:
        return json.loads(t)
    except json.JSONDecodeError as e:
        last_err = e
        if "Invalid \\escape" in str(e):
            try:
                return json.loads(s.replace("\\", "\\\\"))
            except json.JSONDecodeError as e2:
                last_err = e2

    logger.warning(
        f"[JSONParse] Failed to decode JSON: {last_err}\nTail: Raw {response_text} \
        json: {s}"
    )
    raise LLMResponseParseError(
        f"Failed to decode JSON from LLM response: {last_err}"
    ) from last_err


def parse_rewritten_response(text: str) -> tuple[bool, dict[int, dict]]:
    """Parse index-keyed JSON from hallucination filter response.
    Expected shape: { "0": {"need_rewrite": bool, "rewritten": str, "reason": str}, ... }
    Returns (success, parsed_dict) with int keys.
    """
    try:
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE)
        s = (m.group(1) if m else text).strip()
        data = json.loads(s)
    except Exception:
        return False, {}

    if not isinstance(data, dict):
        return False, {}

    result: dict[int, dict] = {}
    for k, v in data.items():
        try:
            idx = int(k)
        except Exception:
            # allow integer keys as-is
            if isinstance(k, int):
                idx = k
            else:
                continue
        if not isinstance(v, dict):
            continue
        need_rewrite = v.get("need_rewrite")
        rewritten = v.get("rewritten", "")
        reason = v.get("reason", "")
        if (
            isinstance(need_rewrite, bool)
            and isinstance(rewritten, str)
            and isinstance(reason, str)
        ):
            result[idx] = {
                "need_rewrite": need_rewrite,
                "rewritten": rewritten,
                "reason": reason,
            }

    return (len(result) > 0), result


def parse_keep_filter_response(text: str) -> tuple[bool, dict[int, dict]]:
    """Parse index-keyed JSON from keep filter response.
    Expected shape: { "0": {"keep": bool, "reason": str}, ... }
    Returns (success, parsed_dict) with int keys.
    """
    try:
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE)
        s = (m.group(1) if m else text).strip()
        data = json.loads(s)
    except Exception:
        return False, {}

    if not isinstance(data, dict):
        return False, {}

    result: dict[int, dict] = {}
    for k, v in data.items():
        try:
            idx = int(k)
        except Exception:
            if isinstance(k, int):
                idx = k
            else:
                continue
        if not isinstance(v, dict):
            continue
        keep = v.get("keep")
        reason = v.get("reason", "")
        if isinstance(keep, bool):
            result[idx] = {
                "keep": keep,
                "reason": reason,
            }
    return (len(result) > 0), result
