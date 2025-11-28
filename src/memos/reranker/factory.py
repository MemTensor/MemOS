# memos/reranker/factory.py
from __future__ import annotations

import json

from typing import TYPE_CHECKING, Any

# Import singleton decorator
from memos.memos_tools.singleton import singleton_factory

from .cosine_local import CosineLocalReranker
from .http_bge import HTTPBGEReranker
from .http_bge_strategy import HTTPBGERerankerStrategy
from .noop import NoopReranker


if TYPE_CHECKING:
    from memos.configs.reranker import RerankerConfigFactory

    from .base import BaseReranker


class RerankerFactory:
    @staticmethod
    @singleton_factory("RerankerFactory")
    def from_config(cfg: RerankerConfigFactory | None) -> BaseReranker | None:
        if not cfg:
            return None

        backend = (cfg.backend or "").lower()
        c: dict[str, Any] = cfg.config or {}

        headers_extra = c.get("headers_extra")
        if isinstance(headers_extra, str):
            try:
                headers_extra = json.loads(headers_extra)
            except Exception:
                headers_extra = None

        if backend in {"http_bge", "bge"}:
            return HTTPBGEReranker(
                reranker_url=c.get("url") or c.get("endpoint") or c.get("reranker_url"),
                model=c.get("model", "bge-reranker-v2-m3"),
                timeout=int(c.get("timeout", 10)),
                headers_extra=headers_extra,
                rerank_source=c.get("rerank_source"),
            )

        if backend in {"cosine_local", "cosine"}:
            return CosineLocalReranker(
                level_weights=c.get("level_weights"),
                level_field=c.get("level_field", "background"),
            )

        if backend in {"noop", "none", "disabled"}:
            return NoopReranker()

        if backend in {"http_bge_strategy", "bge_strategy"}:
            return HTTPBGERerankerStrategy(
                reranker_url=c.get("url") or c.get("endpoint") or c.get("reranker_url"),
                model=c.get("model", "bge-reranker-v2-m3"),
                timeout=int(c.get("timeout", 10)),
                headers_extra=headers_extra,
                rerank_source=c.get("rerank_source"),
                reranker_strategy=c.get("reranker_strategy"),
            )

        raise ValueError(f"Unknown reranker backend: {cfg.backend}")
