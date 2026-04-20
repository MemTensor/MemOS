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


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[\.!?。！？])\s+|\n+")


def chunk_text_by_tokens(
    text: str,
    max_tokens: int,
    overlap_tokens: int,
    count_tokens=None,
) -> list[str]:
    """Token-budgeted chunking with paragraph→sentence→token fallback.

    Used by fast-mode ingestion to split a long message into ~max_tokens
    chunks with overlap_tokens carry-over between consecutive chunks.

    Strategy:
      1. Greedy-pack paragraphs (split on blank lines) up to max_tokens.
      2. If a paragraph alone exceeds max_tokens, split it into sentences
         and greedy-pack those.
      3. If a sentence alone still exceeds max_tokens, slice it by token
         (or character, under the heuristic counter) windows.
      4. Each chunk after the first is prefixed with the trailing
         overlap_tokens of text from the previous chunk to preserve
         cross-chunk context for embeddings/retrieval.

    Returns at least one chunk; never returns empty strings.
    """
    if count_tokens is None:
        count_tokens = count_tokens_text
    if not text:
        return []
    if max_tokens <= 0:
        return [text]
    overlap_tokens = max(0, min(overlap_tokens, max_tokens // 2))

    if count_tokens(text) <= max_tokens:
        return [text]

    units: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if count_tokens(para) <= max_tokens:
            units.append(para)
            continue
        for sent in _SENTENCE_SPLIT_RE.split(para):
            sent = sent.strip()
            if not sent:
                continue
            if count_tokens(sent) <= max_tokens:
                units.append(sent)
                continue
            units.extend(_slice_by_tokens(sent, max_tokens, count_tokens))

    if not units:
        return _slice_by_tokens(text, max_tokens, count_tokens)

    chunks: list[str] = []
    current: list[str] = []
    current_tokens = 0
    for unit in units:
        unit_tokens = count_tokens(unit)
        if current and current_tokens + unit_tokens > max_tokens:
            chunks.append(" ".join(current))
            current = []
            current_tokens = 0
        current.append(unit)
        current_tokens += unit_tokens
    if current:
        chunks.append(" ".join(current))

    if overlap_tokens == 0 or len(chunks) == 1:
        return chunks

    overlapped: list[str] = [chunks[0]]
    for i in range(1, len(chunks)):
        prev_tail = _take_tail_tokens(chunks[i - 1], overlap_tokens, count_tokens)
        overlapped.append(f"{prev_tail} {chunks[i]}".strip() if prev_tail else chunks[i])
    return overlapped


def _slice_by_tokens(text: str, max_tokens: int, count_tokens) -> list[str]:
    """Last-resort slicer for a single unit larger than max_tokens.

    Uses tiktoken when available (precise), otherwise falls back to a
    character-budget proxy (~4 chars/token for English) — same heuristic
    as count_tokens_text, so the slice respects the configured budget.
    """
    try:
        if "_ENC" in globals():
            enc = globals()["_ENC"]
            ids = enc.encode(text, disallowed_special=())
            return [enc.decode(ids[i : i + max_tokens]) for i in range(0, len(ids), max_tokens)]
    except Exception:
        pass
    char_budget = max(1, max_tokens * 4)
    return [text[i : i + char_budget] for i in range(0, len(text), char_budget)]


def _take_tail_tokens(text: str, n_tokens: int, count_tokens) -> str:
    """Return the trailing ~n_tokens of text. Used to seed the next chunk's overlap."""
    if n_tokens <= 0 or not text:
        return ""
    try:
        if "_ENC" in globals():
            enc = globals()["_ENC"]
            ids = enc.encode(text, disallowed_special=())
            return enc.decode(ids[-n_tokens:]) if ids else ""
    except Exception:
        pass
    char_budget = max(1, n_tokens * 4)
    return text[-char_budget:]


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
