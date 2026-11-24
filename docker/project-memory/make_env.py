#!/usr/bin/env python3
"""把 deployment/env.template 渲染成 .env（用于 docker compose）。

    python3 docker/project-memory/make_env.py                # 读 MemOS_DEV/env_example
    python3 docker/project-memory/make_env.py --env-file /path/to/env_example --out .env

规则：
- 只从源文件取下面这几项（其他项一律不抄，避免把公司 PolarDB / Redis 等共享服务的配置带进来）；
- 输出的 .env 里 `NEO4J_URI` / `QDRANT_HOST` 指向 compose 里的容器，不指向本机或共享库；
- 源文件里没有的项用 DEFAULTS 补（env_example 里 `EMBEDDING_DIMENSION` 是注释掉的）；
- 打印时只显示变量名与前 6 位，不打印完整 key。
"""

from __future__ import annotations

import argparse
import sys

from pathlib import Path

from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[2]  # MemOS 仓库根目录

# 需要从源 env 里搬过来的项（键名不变）；另外还有在 template 里固定写死的项
FROM_SOURCE = [
    "OPENAI_API_KEY",
    "OPENAI_API_BASE",
    "MOS_CHAT_MODEL",
    "MOS_EMBEDDER_BACKEND",
    "MOS_EMBEDDER_PROVIDER",
    "MOS_EMBEDDER_MODEL",
    "MOS_EMBEDDER_API_BASE",
    "MOS_EMBEDDER_API_KEY",
    "EMBEDDING_DIMENSION",
    "MEMRADER_MODEL",
    "MEMRADER_API_KEY",
    "MEMRADER_API_BASE",
    "MEMREADER_GENERAL_MODEL",
    "PREFERENCE_EXTRACTOR_MODEL",
    "FEEDBACK_MODEL",
    "SUGGESTION_MODEL",
    "MEMSCHEDULER_MODEL",
]

# 源文件里没有值时的默认（bge-m3 是 1024 维；核心多数配置的默认也是 1024）
DEFAULTS = {"EMBEDDING_DIMENSION": "1024"}


def render(source: dict[str, str | None]) -> str:
    template = (ROOT / "docker" / "project-memory" / "env.template").read_text(encoding="utf-8")
    for key in FROM_SOURCE:
        val = source.get(key) or DEFAULTS.get(key)
        if val:
            template = template.replace(f"__{key}__", val)
    missing = [k for k in FROM_SOURCE if f"__{k}__" in template]
    if missing:
        raise SystemExit(f"这些项在源 env 里没有值：{missing}")
    return template


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=str(Path(ROOT).parents[0] / "env_example"))
    ap.add_argument("--out", default=str(Path(ROOT) / ".env"))
    args = ap.parse_args()

    src_path = Path(args.env_file)
    if not src_path.exists():
        raise SystemExit(f"找不到源 env 文件：{src_path}")
    source = dotenv_values(src_path)
    text = render(source)
    out = Path(args.out)
    out.write_text(text, encoding="utf-8")
    out.chmod(0o600)

    used = {k: (v or "") for k, v in source.items() if k in FROM_SOURCE and v}
    print(f"已写入 {out}（权限 600）。用到的项：")
    for k, v in used.items():
        print(f"  {k} = {v[:6]}…（{len(v)} 字符）")
    print("没搬过来的项一律不进 .env：PolarDB、Redis、QWEN 名单等共享服务配置。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
