import json
import os
import re

from typing import Any

from memos import log
from memos.api.config import APIConfig
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.reranker import RerankerConfigFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.factory import RerankerFactory


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
        logger.error(
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


def build_graph_db_config(user_id: str = "default") -> dict[str, Any]:
    graph_db_backend_map = {
        "neo4j-community": APIConfig.get_neo4j_community_config(user_id=user_id),
        "neo4j": APIConfig.get_neo4j_config(user_id=user_id),
        "nebular": APIConfig.get_nebular_config(user_id=user_id),
        "polardb": APIConfig.get_polardb_config(user_id=user_id),
    }

    graph_db_backend = os.getenv("NEO4J_BACKEND", "nebular").lower()
    return GraphDBConfigFactory.model_validate(
        {
            "backend": graph_db_backend,
            "config": graph_db_backend_map[graph_db_backend],
        }
    )


def build_reranker_config() -> dict[str, Any]:
    return RerankerConfigFactory.model_validate(APIConfig.get_reranker_config())


def init_searcher(llm, embedder) -> Searcher:
    """Initialize a Searcher instance for SimpleStructMemReader."""

    # Build configs
    graph_db_config = build_graph_db_config()
    reranker_config = build_reranker_config()

    # Create instances
    graph_db = GraphStoreFactory.from_config(graph_db_config)
    reranker = RerankerFactory.from_config(reranker_config)

    # Create Searcher
    searcher = Searcher(
        dispatcher_llm=llm,
        graph_store=graph_db,
        embedder=embedder,
        reranker=reranker,
        manual_close_internet=os.getenv("ENABLE_INTERNET", "true").lower() == "false",
    )

    return searcher
