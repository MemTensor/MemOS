# -*- coding: utf-8 -*-
"""项目记忆插件（照 Dream 的形状）。

- `CommunityProjectMemoryPlugin`：`enabled_by_default=False`，用 `MEMOS_ENABLED_PLUGINS=project_memory` 打开；
- 核心（CE 仓库）只该加三样：请求字段（`allow_memory_view` / `include_memory_view` 加 `project`、
  `space_ids`、`domains`）、调度标签 + 薄 handler、单实现钩子。
  <mark>主干这一版还没改核心</mark>，只把算法链路、存储落位与 mock 端到端跑通，见 `demo_mock_add.py` 与
  `研发计划/模块计划/项目记忆_promem_dev主干_20261116.md` 的缺口清单。
"""

from __future__ import annotations

import logging
import os

from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import define_hook


logger = logging.getLogger(__name__)

# 本插件自己的钩子（核心只加字段与调度标签，业务钩子声明在插件里）
H_PROJECT_MEMORY_ACCEPT = "project_memory.accept"  # 是否写入
H_PROJECT_MEMORY_EXTRACT = "project_memory.extract"  # 抽取与合并（单实现）
H_PROJECT_MEMORY_READ = "project_memory.read"  # 检索组装 topic_detail_list


class CommunityProjectMemoryPlugin(MemOSPlugin):
    name = "project_memory"
    version = "0.1.0"
    description = "Project memory view: topic / decision / experience over MemOS Memory nodes"
    enabled_by_default = False

    def on_load(self) -> None:
        define_hook(
            H_PROJECT_MEMORY_ACCEPT,
            description="项目记忆：判断本轮是否要整理（PRD 处理顺序第一步）",
            params=["request", "episode"],
            pipe_key="decision",
        )
        define_hook(
            H_PROJECT_MEMORY_EXTRACT,
            description="项目记忆：episode → 决策 / 经验，并合并落库（单实现）",
            params=["pipeline", "space_id", "episode"],
        )
        define_hook(
            H_PROJECT_MEMORY_READ,
            description="项目记忆：检索并组装 topic_detail_list",
            params=["pipeline", "space_id", "query", "limit"],
            pipe_key="result",
        )
        logger.info("[ProjectMemory] plugin loaded")

    def init_components(self, context: dict) -> None:
        shared = context.get("shared") or {}
        self.graph_db = shared.get("graph_db")
        self.embedder = shared.get("embedder")
        logger.info("[ProjectMemory] components ready (graph_db=%s)", type(self.graph_db).__name__)

    def init_app(self) -> None:
        from .routes import create_router

        self.register_router(create_router(self))
        logger.info("[ProjectMemory] routes registered under /project_memory")

    def build_store(self):
        """生产用 GraphProjectStore（挂 graph_db），没配数据库时退回内存实现（本地演示）。"""
        from .store import GraphProjectStore, InMemoryProjectStore

        if self.graph_db is None:
            return InMemoryProjectStore()
        embedder = None
        if self.embedder is not None:
            embedder = lambda texts: [self.embedder.embed(t) for t in texts]  # noqa: E731
        return GraphProjectStore(self.graph_db, embedder=embedder)

    def on_shutdown(self) -> None:
        logger.info("[ProjectMemory] plugin stopped")


def plugin_enabled() -> bool:
    names = os.getenv("MEMOS_ENABLED_PLUGINS", "")
    return "project_memory" in [n.strip() for n in names.split(",") if n.strip()]
