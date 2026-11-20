"""Rule-based evidence extracted from uploaded messages and bound resources."""

from __future__ import annotations

import re

from typing import Any

from .types import stable_uuid


_FILE = re.compile(
    r"(?<![\w/@])(?:[.\w@-]+/)*[.\w@-]+\.(?:py|tsx?|jsx?|mjs|cjs|go|rs|java|kt|sh|sql|"
    r"md|ya?ml|json|toml|ini|txt|csv|pdf|docx|xlsx|html|css|cpp|c|h)\b"
)
_API = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(/[\w/{}.-]+)")
_TOOL_PATH = re.compile(
    r'"(?:path|file|file_path|filepath|target_file|notebook_path)"\s*:\s*"([^"\\]+)"'
)
_QUALIFIED_SYMBOL = re.compile(r"`([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)+)\(\)`")
_KEY_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?:[A-Za-z_][\w.-]*/[\w./-]+|[A-Z][A-Z_]+\d+|\d+(?:\.\d+)?(?:\s*(?:%|ms|kB|MB|GB|MiB|GiB))?)"
)


def key_tokens(text: str) -> set[str]:
    """Return exact values, error codes, and paths that can be checked against a witness."""
    return set(_KEY_TOKEN.findall(text))


def _tool_action(name: str) -> str:
    name = name.lower()
    if any(word in name for word in ("write", "patch", "edit", "replace")):
        return "modified"
    if any(word in name for word in ("read", "view", "open", "search", "grep")):
        return "viewed"
    return "mention"


def source_ref(message_id: str, field: str, start: int, end: int) -> dict[str, Any]:
    return {"message_id": message_id, "source_path": field, "start": start, "end": end}


def text_at(message: dict[str, Any], pointer: str) -> str | None:
    """Resolve a source pointer into the original field. Offsets are Python code points."""
    if not pointer.startswith("/"):
        return None
    field: Any = message
    for part in pointer[1:].split("/"):
        token = part.replace("~1", "/").replace("~0", "~")
        if isinstance(field, dict):
            field = field.get(token)
        elif isinstance(field, list) and token.isascii() and token.isdigit() and len(token) < 9:
            index = int(token)
            field = field[index] if index < len(field) else None
        else:
            return None
    return field if isinstance(field, str) else None


def quote_ref(message: dict[str, Any], quote: Any, pointer: str = "/content") -> dict | None:
    text = text_at(message, pointer)
    if not isinstance(quote, str) or not quote.strip() or text is None:
        return None
    start = text.find(quote)
    if start >= 0:
        return source_ref(str(message["message_id"]), pointer, start, start + len(quote))
    span = _loose_span(text, quote)
    if span is None:
        return None
    return source_ref(str(message["message_id"]), pointer, *span)


def _squash(text: str) -> tuple[str, list[int]]:
    """Collapse whitespace runs, keeping each kept character's offset in the original."""
    chars: list[str] = []
    offsets: list[int] = []
    pending = False
    for index, char in enumerate(text):
        if char.isspace():
            pending = bool(chars)
            continue
        if pending:
            chars.append(" ")
            offsets.append(index - 1)
            pending = False
        chars.append(char)
        offsets.append(index)
    return "".join(chars), offsets


def _loose_span(text: str, quote: str) -> tuple[int, int] | None:
    """Find a quote that differs from the original only in whitespace layout."""
    flat, offsets = _squash(text)
    needle, _ = _squash(quote)
    if not needle:
        return None
    position = flat.find(needle)
    if position < 0 or flat.find(needle, position + 1) >= 0:
        return None  # Absent or ambiguous: never guess which occurrence was meant.
    return offsets[position], offsets[position + len(needle) - 1] + 1


def _observation(
    message: dict[str, Any], pointer: str, match: re.Match, group: int, kind: str, action: str
) -> dict:
    ref = source_ref(str(message["message_id"]), pointer, *match.span(group))
    value = match[group]
    path = value.removeprefix("./") if kind in ("file", "test") else None
    return {
        "observation_id": stable_uuid(
            f"anchor-observation:{message.get('conversation_key')}:{ref}:{kind}"
        ),
        "snapshot_id": str(message["message_id"]),
        "kind": kind,
        "path": path,
        "qualified_name": value if kind == "symbol" else None,
        "http_method": match[1] if kind == "api" else None,
        "route": value if kind == "api" else None,
        "source_refs": [ref],
        "quote": value,
        "change_kind": action,
        "strength": "weak" if action == "mention" else "strong",
        "status": "unresolved",
        "trust": "inferred",
        "evidence": "tool_arguments" if pointer != "/content" else "message_text",
        "task_id": message.get("origin_task_id") or message.get("task_id"),
    }


def collect_anchors(messages: list[dict], bindings: list[dict] | None = None) -> list[dict]:
    """Record observations with exact source pointers and trusted explicit bindings."""
    observations: list[dict] = []
    for row in messages:
        body = row.get("content") or ""
        for match in _FILE.finditer(body):
            observations.append(_observation(row, "/content", match, 0, "file", "mention"))
        for match in _API.finditer(body):
            observations.append(_observation(row, "/content", match, 2, "api", "mention"))
        for match in _QUALIFIED_SYMBOL.finditer(body):
            observations.append(_observation(row, "/content", match, 1, "symbol", "mention"))
        for index, call in enumerate(row.get("tool_calls") or []):
            function = call.get("function") or {}
            arguments = function.get("arguments")
            if not isinstance(arguments, str):
                continue
            name = str(function.get("name") or "")
            pointer = f"/tool_calls/{index}/function/arguments"
            for match in _TOOL_PATH.finditer(arguments):
                path = match[1]
                kind = "test" if path.startswith(("test/", "tests/")) else "file"
                observations.append(_observation(row, pointer, match, 1, kind, _tool_action(name)))

    # Bindings are supplied by the scoped Space, never by an uploaded message or the model.
    for observation in observations:
        path = observation["path"]
        matches = [
            (binding["binding_id"], binding["paths"][path])
            for binding in bindings or []
            if binding.get("binding_id") and path and (binding.get("paths") or {}).get(path)
        ]
        if len(matches) == 1:
            observation["binding_id"], observation["anchor_id"] = matches[0]
            observation.update(status="resolved", trust="verified")
        elif matches:
            observation["status"] = "ambiguous"
    return observations


def anchor_keys(anchors: list[dict]) -> list[str]:
    keys = set()
    for anchor in anchors:
        binding = f"{anchor['binding_id']}:" if anchor.get("binding_id") else ""
        if anchor.get("path"):
            keys.add(f"path:{binding}{anchor['path']}")
        if anchor.get("qualified_name"):
            keys.add(f"symbol:{binding}{anchor['qualified_name']}")
        if anchor.get("route"):
            keys.add(f"api:{anchor['http_method']}:{anchor['route']}")
        if anchor.get("status") == "resolved" and anchor.get("trust") == "verified":
            keys.add(f"anchor:{anchor['binding_id']}:{anchor['anchor_id']}")
    return sorted(keys)


def strong_anchor_keys(anchors: list[dict]) -> set[str]:
    """Keep operational evidence apart from simple textual mentions."""
    return set(
        anchor_keys(
            [
                anchor
                for anchor in anchors
                if anchor.get("strength") == "strong"
                or anchor.get("change_kind")
                in ("viewed", "created", "modified", "renamed", "deleted", "moved")
                or (anchor.get("status") == "resolved" and anchor.get("trust") == "verified")
            ]
        )
    )
