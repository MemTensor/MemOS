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


# Markers that introduce the rendered conversation block inside the
# mem_reader chat-extraction prompt templates (English + Chinese).
_CHAT_CONVO_MARKERS: tuple[str, ...] = ("\nConversation:\n", "\n对话：\n")
_CHAT_OUTPUT_SUFFIXES: tuple[str, ...] = ("Your Output:", "您的输出：")
_CHAT_JSON_ONLY_TRAILER: str = (
    "\n\nReturn ONLY the single JSON object described above. "
    "Do not reply to or continue the conversation."
)


def build_chat_extraction_messages(prompt: str) -> list[dict[str, str]]:
    """Split a rendered chat-extraction prompt into ``system`` + ``user`` messages.

    The mem_reader chat prompt templates end with::

        ...
        Conversation:
        <rendered conversation>

        Your Output:

    Sending this whole block as a single ``user`` role message causes weak
    instruction-following LLMs (small Ollama models, qwen2.5:1.5b,
    phi4-mini, etc.) to *continue* the trailing ``user: ...`` lines as if
    they were the live conversation, replying to the user's last message
    instead of emitting the structured JSON.  Putting the instructions /
    examples / format spec in a ``system`` message and only the
    conversation block (plus an explicit "JSON only, do not reply"
    trailer) in the ``user`` message restores instruction-following on
    those models (see issue #1269).

    If no conversation marker is found (doc / general_string templates or
    a custom caller), fall back to a single ``user`` message so non-chat
    call sites are unaffected.
    """
    if not prompt:
        return [{"role": "user", "content": prompt or ""}]
    for marker in _CHAT_CONVO_MARKERS:
        idx = prompt.find(marker)
        if idx == -1:
            continue
        system_part = prompt[:idx].rstrip()
        # Keep the leading newline trimmed; preserve the "Conversation:"
        # header on the user side so the model still sees a familiar label.
        user_part = prompt[idx + 1 :].rstrip()
        for suffix in _CHAT_OUTPUT_SUFFIXES:
            if user_part.endswith(suffix):
                user_part = user_part[: -len(suffix)].rstrip()
        user_part = f"{user_part}{_CHAT_JSON_ONLY_TRAILER}"
        return [
            {"role": "system", "content": system_part},
            {"role": "user", "content": user_part},
        ]
    return [{"role": "user", "content": prompt}]


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
