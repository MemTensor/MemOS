import json
import re

from memos import log


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


def _strip_trailing_commas(text: str) -> str:
    """Remove commas that sit immediately before ``}`` or ``]`` (ignoring
    whitespace in between), but only when the comma is **outside** a quoted
    string. Respects backslash-escaped quotes inside strings.

    This repairs the single most common malformed-JSON failure mode from
    permissive LLM output (e.g. ``[{"value": "x"},]`` or ``{"a": 1,}``) that
    historically caused :func:`parse_json_result` to silently return ``{}``
    and the ``/product/add`` endpoint to report a success with no stored
    memories (issue #2456).

    The scanner is deliberately minimal: it does not try to invent missing
    values, close unmatched braces, or repair arbitrary malformed output.
    Those jobs stay with the ``_cheap_close`` branch and the final ``{}``
    return.
    """
    out: list[str] = []
    in_string = False
    escape = False
    pending_comma_idx: int | None = None  # index into ``out`` of a comma eligible for removal
    for ch in text:
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue

        # ---- outside string ----
        if ch == '"':
            pending_comma_idx = None
            in_string = True
            out.append(ch)
            continue

        if ch == ",":
            out.append(ch)
            pending_comma_idx = len(out) - 1
            continue

        if ch in (" ", "\t", "\n", "\r"):
            # whitespace does not invalidate a pending trailing-comma repair
            out.append(ch)
            continue

        if ch in ("}", "]") and pending_comma_idx is not None:
            # Drop the pending comma; whitespace between comma and closer stays.
            out[pending_comma_idx] = ""
            pending_comma_idx = None
            out.append(ch)
            continue

        pending_comma_idx = None
        out.append(ch)

    return "".join(out)


def parse_json_result(response_text: str) -> dict:
    s = (response_text or "").strip()

    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, flags=re.I)
    s = (m.group(1) if m else s.replace("```", "")).strip()

    i = s.find("{")
    if i == -1:
        return {}
    s = s[i:].strip()

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    j = max(s.rfind("}"), s.rfind("]"))
    if j != -1:
        try:
            return json.loads(s[: j + 1])
        except json.JSONDecodeError:
            pass

    def _cheap_close(t: str) -> str:
        t += "}" * max(0, t.count("{") - t.count("}"))
        t += "]" * max(0, t.count("[") - t.count("]"))
        return t

    t = _cheap_close(s)
    try:
        return json.loads(t)
    except json.JSONDecodeError as e:
        if "Invalid \\escape" in str(e):
            s = s.replace("\\", "\\\\")
            return json.loads(s)

        # Issue #2456: last-chance narrow repair for trailing commas before
        # ``}`` / ``]`` (outside quoted strings). Many LLMs — glm, kimi,
        # z.ai gateway — occasionally emit ``[...],]`` which is invalid JSON
        # and used to be silently dropped as ``{}``, surfacing as an empty
        # successful ``/product/add``.
        repaired = _strip_trailing_commas(t)
        if repaired != t:
            try:
                result = json.loads(repaired)
                logger.warning(
                    "[JSONParse] Repaired malformed JSON by stripping "
                    "trailing comma(s) before closer: %s",
                    e,
                )
                return result
            except json.JSONDecodeError:
                pass

        logger.warning(
            f"[JSONParse] Failed to decode JSON: {e}\nTail: Raw {response_text} \
            json: {s}"
        )
        return {}


def parse_rewritten_response(text: str) -> tuple[bool, dict[int, dict]]:
    """Parse index-keyed JSON from hallucination filter response.
    Expected shape: { "0": {"need_rewrite": bool, "rewritten": str, "reason": str}, ... }
    Returns (success, parsed_dict) with int keys.
    """
    try:
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.I)
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
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.I)
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
