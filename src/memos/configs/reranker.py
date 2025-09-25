# memos/configs/reranker.py
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class RerankerConfigFactory(BaseModel):
    """
    {
      "backend": "http_bge" | "cosine_local" | "noop",
      "config": { ... backend-specific ... }
    }
    """

    backend: str = Field(..., description="Reranker backend id")
    config: dict[str, Any] = Field(default_factory=dict, description="Backend-specific options")
