#!/usr/bin/env python3
"""
智能迁移 Hermes 记忆到 memos 的 4 层记忆系统

分类规则:
- MEMORY.md 中的技术事实 → text_mem (文本记忆)
- USER.md 中的用户偏好 → pref_mem (偏好记忆)
- 关键词识别: 偏好/喜欢/习惯/风格 → pref_mem

用法:
    python migrate_hermes_memory.py                    # 交互式迁移
    python migrate_hermes_memory.py --auto             # 自动迁移(使用默认分类)
    python migrate_hermes_memory.py --dry-run          # 预览分类结果
"""

import json
import sys

from pathlib import Path

import requests


# memos 配置
MEMOS_URL = "http://127.0.0.1:8766/mcp"

# 分类关键词
PREFERENCE_KEYWORDS = [
    "偏好",
    "喜欢",
    "习惯",
    "风格",
    "期望",
    "倾向",
    "prefer",
    "like",
    "want",
    "沟通",
    "交流",
    "interaction",
    "communication",
    "style",
]

TECHNICAL_KEYWORDS = [
    "项目",
    "环境",
    "配置",
    "部署",
    "版本",
    "集群",
    "数据库",
    "服务",
    "project",
    "environment",
    "config",
    "deploy",
    "cluster",
    "database",
]


def read_hermes_memory() -> tuple[list[str], list[str]]:
    """读取 Hermes 的 MEMORY.md 和 USER.md"""
    hermes_home = Path.home() / ".hermes"
    memory_dir = hermes_home / "memories"

    memory_entries = []
    user_entries = []

    # 读取 MEMORY.md
    memory_file = memory_dir / "MEMORY.md"
    if memory_file.exists():
        content = memory_file.read_text(encoding="utf-8")
        memory_entries = [e.strip() for e in content.split("§") if e.strip()]

    # 读取 USER.md
    user_file = memory_dir / "USER.md"
    if user_file.exists():
        content = user_file.read_text(encoding="utf-8")
        user_entries = [e.strip() for e in content.split("§") if e.strip()]

    return memory_entries, user_entries


def classify_memory(entry: str, source: str) -> str:
    """
    智能分类记忆到 memos 的 4 层

    返回: 'text_mem' | 'pref_mem' | 'act_mem' | 'para_mem'
    """
    entry_lower = entry.lower()

    # USER.md 默认倾向于 pref_mem
    if source == "USER.md":
        # 检查是否是纯技术信息(虽然是 USER.md 但内容是技术栈)
        tech_score = sum(1 for kw in TECHNICAL_KEYWORDS if kw in entry_lower)
        pref_score = sum(1 for kw in PREFERENCE_KEYWORDS if kw in entry_lower)

        if pref_score > tech_score:
            return "pref_mem"
        elif tech_score > 2:  # 技术关键词很多, 可能是技术背景
            return "text_mem"
        else:
            return "pref_mem"  # 默认偏好

    # MEMORY.md 默认倾向于 text_mem
    else:
        # 检查是否包含明显的偏好信息
        pref_score = sum(1 for kw in PREFERENCE_KEYWORDS if kw in entry_lower)
        if pref_score > 2:
            return "pref_mem"
        else:
            return "text_mem"  # 默认文本记忆


def init_mcp_session(session: requests.Session, url: str) -> str:
    """初始化 MCP 会话, 返回 session_id"""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "hermes-migrator", "version": "1.0"},
        },
    }
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    resp = session.post(url, json=payload, headers=headers, timeout=10)
    if resp.status_code != 200:
        raise Exception(f"MCP initialize failed: HTTP {resp.status_code}")
    session_id = resp.headers.get("Mcp-Session-Id")
    if not session_id:
        raise Exception("MCP initialize: no session_id in response")
    return session_id


def parse_sse_response(text: str) -> dict:
    """解析 SSE 格式响应: event: message\\r\\ndata: {json}"""
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            json_str = line[6:]
            return json.loads(json_str)
    return {}


def build_memory_tool_call(entry: dict, request_id: int) -> dict:
    """Build the native MemOS MCP request for one classified Hermes memory."""
    content = entry["content"]
    target_layer = entry["layer"]
    if target_layer == "text_mem":
        tool_name = "add_memory"
        arguments = {"memory_content": content}
    elif target_layer == "pref_mem":
        tool_name = "add_preference_memory"
        arguments = {"preference": content}
    else:
        raise ValueError(f"Unsupported memory layer: {target_layer}")

    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
        },
    }


def migrate_to_memos(entries: list[dict], dry_run: bool = False) -> dict[str, int]:
    """
    迁移记忆到 memos

    返回: {'text_mem': count, 'pref_mem': count, ...}
    """
    stats = {"text_mem": 0, "pref_mem": 0, "act_mem": 0, "para_mem": 0}

    # 禁用代理
    session = requests.Session()
    session.trust_env = False
    session.proxies = {"http": None, "https": None}

    # 初始化 MCP 会话
    if not dry_run:
        print("  初始化 MCP 会话...")
        try:
            session_id = init_mcp_session(session, MEMOS_URL)
            print(f"  ✓ Session ID: {session_id[:16]}...")
        except Exception as e:
            print(f"  ✗ {e}")
            return stats
    else:
        session_id = "dry-run"

    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": session_id,
    }

    for request_id, entry in enumerate(entries, start=2):
        content = entry["content"]
        target_layer = entry["layer"]

        print(f"\n[{target_layer}] {content[:80]}...")

        if dry_run:
            print(f"  → 将迁移到 {target_layer}")
            stats[target_layer] += 1
            continue

        if target_layer not in ("text_mem", "pref_mem"):
            print(f"  ⚠️  {target_layer} 不支持文本迁移，跳过")
            continue

        payload = build_memory_tool_call(entry, request_id)

        try:
            resp = session.post(MEMOS_URL, json=payload, headers=headers, timeout=30)

            if resp.status_code == 200:
                result = parse_sse_response(resp.text)
                is_error = result.get("result", {}).get("isError", True)
                if not is_error:
                    print("  ✓ 已迁移")
                    stats[target_layer] += 1
                else:
                    content_list = result.get("result", {}).get("content", [])
                    error_msg = (
                        content_list[0].get("text", "Unknown error")
                        if content_list
                        else "Unknown error"
                    )
                    print(f"  ✗ 迁移失败: {error_msg}")
            else:
                print(f"  ✗ HTTP {resp.status_code}: {resp.text[:200]}")

        except Exception as e:
            print(f"  ✗ 请求失败: {e}")

    return stats


def main():
    import argparse

    parser = argparse.ArgumentParser(description="智能迁移 Hermes 记忆到 memos")
    parser.add_argument("--auto", action="store_true", help="自动迁移（使用默认分类）")
    parser.add_argument("--dry-run", action="store_true", help="预览分类结果，不实际迁移")
    args = parser.parse_args()

    print("=" * 60)
    print("Hermes → memos 智能记忆迁移工具")
    print("=" * 60)

    # 1. 读取 Hermes 记忆
    print("\n[1/3] 读取 Hermes 记忆...")
    memory_entries, user_entries = read_hermes_memory()
    print(f"  MEMORY.md: {len(memory_entries)} 条")
    print(f"  USER.md: {len(user_entries)} 条")

    if not memory_entries and not user_entries:
        print("\n✗ 没有找到 Hermes 记忆文件")
        sys.exit(1)

    # 2. 智能分类
    print("\n[2/3] 智能分类到 memos 4 层记忆...")

    classified_entries = []

    for entry in memory_entries:
        layer = classify_memory(entry, "MEMORY.md")
        classified_entries.append({"content": entry, "layer": layer, "source": "MEMORY.md"})

    for entry in user_entries:
        layer = classify_memory(entry, "USER.md")
        classified_entries.append({"content": entry, "layer": layer, "source": "USER.md"})

    # 统计分类结果
    layer_counts = {}
    for entry in classified_entries:
        layer = entry["layer"]
        layer_counts[layer] = layer_counts.get(layer, 0) + 1

    print("\n分类结果:")
    for layer, count in sorted(layer_counts.items()):
        print(f"  {layer}: {count} 条")

    if not args.auto and not args.dry_run:
        print("\n[交互模式] 是否继续迁移？(y/n)")
        if input().strip().lower() != "y":
            print("已取消")
            sys.exit(0)

    # 3. 执行迁移
    print("\n[3/3] 迁移到 memos...")

    if args.dry_run:
        print("\n[DRY RUN 模式] 仅预览，不实际写入")

    stats = migrate_to_memos(classified_entries, dry_run=args.dry_run)

    # 4. 汇总
    print("\n" + "=" * 60)
    print("迁移完成！")
    print("=" * 60)

    for layer, count in stats.items():
        if count > 0:
            print(f"  {layer}: {count} 条")

    if not args.dry_run:
        print("\n✓ 记忆已迁移到 memos")
        print("\n提示:")
        print("  - 可用 search_memories 搜索记忆")
        print("  - pref_mem 目前通过 [PREFERENCE] 标签区分")
        print("  - 重启 Hermes 后可验证迁移效果")


if __name__ == "__main__":
    main()
