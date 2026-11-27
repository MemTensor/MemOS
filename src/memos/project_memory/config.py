"""项目记忆自己的配置：模型、向量模型、存储。全部走 MemOS 现成的工厂（LLMFactory / EmbedderFactory / GraphStoreFactory）。

为什么单独配：核心的 `llm` 温度是 `MOS_CHAT_TEMPERATURE`（默认 0.8），项目记忆的提示词要求温度 0；
判别题可以用更便宜的模型；项目记忆迁移前用自己的库（11/16 定）。没配的项一律退回核心的配置。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| PROJECT_MEMORY_LLM_BACKEND | openai | LLMFactory 的 backend：openai / qwen / deepseek / vllm / ollama … |
| PROJECT_MEMORY_LLM_MODEL | MOS_CHAT_MODEL | 抽取、更新、合并、归主题用的模型 |
| PROJECT_MEMORY_LLM_API_BASE | OPENAI_API_BASE | |
| PROJECT_MEMORY_LLM_API_KEY | OPENAI_API_KEY | |
| PROJECT_MEMORY_LLM_TEMPERATURE | 0 | |
| PROJECT_MEMORY_LLM_MAX_TOKENS | 4096 | |
| PROJECT_MEMORY_LLM_THINKING_MODE | 提供方默认 | OpenAI 兼容 Chat Completions 的 thinking.type，可设 enabled 或 disabled |
| PROJECT_MEMORY_JUDGE_LLM_THINKING_MODE | 提供方默认 | 判别模型单独设置 thinking.type |
| PROJECT_MEMORY_JUDGE_LLM_* | 同上一组 | 判别题（段关系）用的模型，可换小模型；同名后缀 |
| PROJECT_MEMORY_EMBEDDER_* | 核心的 embedder（MOS_EMBEDDER_*） | BACKEND / PROVIDER / MODEL / API_BASE / API_KEY / DIMENSION |
| PROJECT_MEMORY_GRAPH_DB | sqlite | sqlite：自己的 SQLite 文件（单进程、本机试用）；postgres：项目记忆自己的 Postgres 表（pg_backend.py，多副本共享，带 rev 条件写与中文全文）；shared：直接用核心的 graph_db（须支持 search_by_fulltext 与 rev 条件写，neo4j 两种后端都不支持） |
| PROJECT_MEMORY_SQLITE_PATH | $MEMOS_BASE_PATH/.memos/project_memory.db | |
| PROJECT_DB_HOST / PORT / USER / PASSWORD / NAME | 退回 PROJECT_MEMORY_POSTGRES_*，再退回 POSTGRES_* | 与存储层 memos.project_dbs 共用；也可用 PROJECT_MEMORY_POSTGRES_DSN 一次给全 |
| PROJECT_DB_TEXT_SEARCH_PARSER | zhparser | 共享表的中文全文配置；本地没有 zhparser 时设 simple |
| PROJECT_MEMORY_LIMITS_FILE | 无 | 长度上限的 YAML/JSON 文件，只写要改的键；默认值见 memos/configs/project_memory_limits.yaml |
| PROJECT_MEMORY_LIMIT_<KEY> | 见上述 YAML | 单项覆盖，如 PROJECT_MEMORY_LIMIT_TOPIC_SUMMARY=200；按「字」计（一个汉字或一个英文单词），优先级最高 |
| PROJECT_MEMORY_POSTGRES_SCHEMA | project_memory | 表建在这个 schema 下，与核心的表分开 |
| PROJECT_MEMORY_POSTGRES_MAX_CONNECTIONS | 10 | 连接池上限；并行整理时每个线程占一个 |
| PROJECT_MEMORY_PARALLEL_EPISODE | true | 一段之内决策与经验两条线并行 |
| PROJECT_MEMORY_NAIVE_TZ | 服务器本地时区 | 没带时区的 chat_time 按这个偏移理解，如 `+08:00`（只认偏移写法） |
"""

from __future__ import annotations

import logging
import os

from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


def _env(name: str, *fallbacks: str, default: str | None = None) -> str | None:
    for key in (name, *fallbacks):
        val = os.getenv(key)
        if val not in (None, ""):
            return val
    return default


def llm_config(prefix: str = "PROJECT_MEMORY_LLM") -> dict[str, Any] | None:
    """返回 LLMConfigFactory 的入参；没有任何可用的模型配置时返回 None。"""
    base = "PROJECT_MEMORY_LLM"
    model = _env(f"{prefix}_MODEL", f"{base}_MODEL", "MOS_CHAT_MODEL")
    api_key = _env(f"{prefix}_API_KEY", f"{base}_API_KEY", "OPENAI_API_KEY")
    if not model or not api_key:
        return None
    backend = _env(f"{prefix}_BACKEND", f"{base}_BACKEND", default="openai")
    options: dict[str, Any] = {
        "backend": backend,
        "config": {
            "model_name_or_path": model,
            "api_key": api_key,
            "api_base": _env(
                f"{prefix}_API_BASE",
                f"{base}_API_BASE",
                "OPENAI_API_BASE",
                default="https://api.openai.com/v1",
            ),
            "temperature": float(_env(f"{prefix}_TEMPERATURE", f"{base}_TEMPERATURE", default="0")),
            "max_tokens": int(_env(f"{prefix}_MAX_TOKENS", f"{base}_MAX_TOKENS", default="4096")),
            "top_p": 1.0,
            "remove_think_prefix": True,
        },
    }
    mode_key = f"{prefix}_THINKING_MODE"
    if mode := _env(mode_key):
        if mode not in {"enabled", "disabled"} or backend != "openai":
            raise ValueError(
                f"{mode_key} requires enabled or disabled with the openai Chat Completions backend"
            )
        options["config"]["extra_body"] = {"thinking": {"type": mode}}
    return options


def build_llm(prefix: str = "PROJECT_MEMORY_LLM") -> Any | None:
    cfg = llm_config(prefix)
    if cfg is None:
        return None
    from memos.configs.llm import LLMConfigFactory
    from memos.llms.factory import LLMFactory

    llm = LLMFactory.from_config(LLMConfigFactory.model_validate(cfg))
    logger.info(
        "[ProjectMemory] %s = %s/%s", prefix, cfg["backend"], cfg["config"]["model_name_or_path"]
    )
    return llm


def embedder_config() -> dict[str, Any] | None:
    p = "PROJECT_MEMORY_EMBEDDER"
    backend = _env(f"{p}_BACKEND", "MOS_EMBEDDER_BACKEND")
    if backend != "universal_api":
        return None  # 其余后端（ollama 等）用核心的 embedder
    key = _env(f"{p}_API_KEY", "MOS_EMBEDDER_API_KEY")
    if not key:
        return None
    return {
        "backend": "universal_api",
        "config": {
            "provider": _env(f"{p}_PROVIDER", "MOS_EMBEDDER_PROVIDER", default="openai"),
            "api_key": key,
            "model_name_or_path": _env(f"{p}_MODEL", "MOS_EMBEDDER_MODEL", default="bge-m3"),
            "embedding_dims": int(_env(f"{p}_DIMENSION", "EMBEDDING_DIMENSION", default="1024")),
            "base_url": _env(f"{p}_API_BASE", "MOS_EMBEDDER_API_BASE"),
        },
    }


def build_embedder() -> Any | None:
    cfg = embedder_config()
    if cfg is None:
        return None
    from memos.configs.embedder import EmbedderConfigFactory
    from memos.embedders.factory import EmbedderFactory

    return EmbedderFactory.from_config(EmbedderConfigFactory.model_validate(cfg))


def sqlite_path() -> str:
    explicit = os.getenv("PROJECT_MEMORY_SQLITE_PATH")
    if explicit:
        return explicit
    from memos import settings

    return str(Path(settings.MEMOS_DIR) / "project_memory.db")


def embedding_dims() -> int:
    p = "PROJECT_MEMORY_EMBEDDER"
    return int(_env(f"{p}_DIMENSION", "EMBEDDING_DIMENSION", default="1024"))


def postgres_config(embedding_dimension: int | None = None) -> dict[str, Any]:
    """The project memory PostgreSQL. PROJECT_DB_* (the shared storage layer, memos.project_dbs)
    take precedence, then PROJECT_MEMORY_POSTGRES_*, then the core POSTGRES_*."""

    def pick(name: str, legacy: str, core: str, default: str) -> str:
        for key in (f"PROJECT_DB_{name}", f"PROJECT_MEMORY_POSTGRES_{legacy}", core):
            value = os.getenv(key)
            if value is not None and (value or key.endswith("PASSWORD")):
                return value
        return default

    return {
        "host": pick("HOST", "HOST", "POSTGRES_HOST", "postgres"),
        "port": int(pick("PORT", "PORT", "POSTGRES_PORT", "5432")),
        "user": pick("USER", "USER", "POSTGRES_USER", "postgres"),
        "password": pick("PASSWORD", "PASSWORD", "POSTGRES_PASSWORD", ""),
        "db_name": pick("NAME", "DB", "POSTGRES_DB", "postgres"),
        # The shared storage layer uses the fixed schema project_memory.
        "schema_name": os.getenv("PROJECT_MEMORY_POSTGRES_SCHEMA", "project_memory"),
        "dsn": os.getenv("PROJECT_MEMORY_POSTGRES_DSN") or None,
        "max_connections": int(
            os.getenv("PROJECT_DB_MAX_CONN")
            or os.getenv("PROJECT_MEMORY_POSTGRES_MAX_CONNECTIONS", "10")
        ),
        "user_name": os.getenv("PROJECT_MEMORY_POSTGRES_USER_NAME", "project_memory"),
        "use_multi_db": False,
        "embedding_dimension": embedding_dimension or embedding_dims(),
        # zhparser in production; simple where the extension is not installed (tests).
        "text_search_parser": (os.getenv("PROJECT_DB_TEXT_SEARCH_PARSER") or "zhparser")
        .strip()
        .lower(),
    }


def build_graph_db(
    shared_graph_db: Any | None = None, embedding_dimension: int | None = None
) -> Any:
    """按 PROJECT_MEMORY_GRAPH_DB 选存储：sqlite（默认）/ postgres / shared（用核心的 graph_db）。

    默认 sqlite：核心常用的 neo4j-community 没有全文检索（search_by_fulltext 返回空）、也没有
    rev 条件写，项目记忆放进去会少一路召回、并发写会丢更新。
    """
    kind = os.getenv("PROJECT_MEMORY_GRAPH_DB", "sqlite")
    if kind == "shared":
        if shared_graph_db is None:
            raise RuntimeError("PROJECT_MEMORY_GRAPH_DB=shared，但插件上下文里没有 graph_db")
        return shared_graph_db
    from memos.configs.graph_db import GraphDBConfigFactory
    from memos.graph_dbs.factory import GraphStoreFactory

    dims = embedding_dimension or embedding_dims()
    if kind == "sqlite":
        logger.warning(
            "项目记忆存在 SQLite 文件 %s：只适合单进程。多 worker / 多副本部署请设 "
            "PROJECT_MEMORY_GRAPH_DB=postgres，否则并行整理会丢更新、重复建主题",
            sqlite_path(),
        )
        cfg = {
            "backend": "sqlite",
            "config": {"db_path": sqlite_path(), "embedding_dimension": dims},
        }
    elif kind == "postgres":
        # 项目记忆自己的 Postgres 存储（插件目录里的新文件，不经核心的 postgres 后端）
        from .pg_backend import ProjectPostgresStore

        return ProjectPostgresStore(postgres_config(dims))
    else:
        raise ValueError(f"PROJECT_MEMORY_GRAPH_DB 只支持 shared / sqlite / postgres，收到 {kind}")
    return GraphStoreFactory.from_config(GraphDBConfigFactory.model_validate(cfg))
