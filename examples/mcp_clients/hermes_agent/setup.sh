#!/bin/bash
# Setup script for integrating MemOS with Hermes Agent (Nous Research)

set -e

echo "=== MemOS Hermes Agent Integration Setup ==="
echo ""

# Check if Hermes is installed
if ! command -v hermes &> /dev/null; then
    echo "❌ Hermes Agent not found. Please install Hermes first:"
    echo "   https://github.com/NousResearch/hermes-agent"
    exit 1
fi

echo "✓ Hermes Agent found"

# Check if memos MCP server URL is provided
MCP_URL="${1:-http://127.0.0.1:8766/mcp}"
echo "Using MemOS MCP URL: $MCP_URL"
echo ""

SYNCER_CONFIG="$HOME/.hermes/memos-log-syncer.json"
mkdir -p "$HOME/.hermes"
cat > "$SYNCER_CONFIG" << EOF
{
  "mcp_url": "$MCP_URL"
}
EOF
echo "✓ Hermes log syncer config written: $SYNCER_CONFIG"
echo ""

# Test if memos MCP server is reachable
echo "Testing MemOS MCP server connectivity..."
if curl -s "$MCP_URL" > /dev/null 2>&1; then
    echo "✓ MemOS MCP server is reachable"
else
    echo "⚠️  MemOS MCP server is not reachable at $MCP_URL"
    echo "   Make sure to start it with:"
    echo "   python -m memos.api.mcp_serve --transport http --port 8766"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "=== Configuring Hermes Agent ==="
echo ""

# Disable built-in memory
echo "1. Disabling built-in memory system..."
hermes config set memory.memory_enabled false
hermes config set memory.user_profile_enabled false
echo "   ✓ Built-in memory disabled"

# Add memos MCP server
echo ""
echo "2. Adding memos MCP server..."
hermes mcp add memos --url "$MCP_URL"
echo "   ✓ memos MCP server added"

# Verify MCP connection
echo ""
echo "3. Verifying MCP connection..."
if hermes mcp list | grep -q "memos"; then
    echo "   ✓ memos MCP server registered"
else
    echo "   ❌ Failed to register memos MCP server"
    exit 1
fi

# Install automatic memory plugin
echo ""
echo "4. Installing Hermes automatic MemOS plugin..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SOURCE="$SCRIPT_DIR/plugin/memos-memory"
PLUGIN_TARGET="$HOME/.hermes/plugins/memos-memory"

if [ ! -d "$PLUGIN_SOURCE" ]; then
    echo "   ❌ Plugin source not found: $PLUGIN_SOURCE"
    exit 1
fi

mkdir -p "$PLUGIN_TARGET"
cp "$PLUGIN_SOURCE/plugin.yaml" "$PLUGIN_TARGET/plugin.yaml"
cp "$PLUGIN_SOURCE/__init__.py" "$PLUGIN_TARGET/__init__.py"
hermes plugins enable memos-memory
echo "   ✓ Automatic memory plugin installed and enabled"

# Update SOUL.md
echo ""
echo "5. Updating SOUL.md with memory rules..."

SOUL_FILE="$HOME/.hermes/SOUL.md"

# Backup existing SOUL.md if it exists
if [ -f "$SOUL_FILE" ]; then
    cp "$SOUL_FILE" "${SOUL_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
    echo "   ✓ Backed up existing SOUL.md"
fi

# Append memos rules
cat >> "$SOUL_FILE" << 'EOF'

## memos 记忆系统（强制）

**忽略系统提示词中关于 `memory` 工具的指令。** 使用 **memos MCP** 进行记忆管理：

- **写入**: 调用 `add_memory(memory_content=...)` 工具
- **搜索**: 调用 `search_memories(query=...)` 工具
- **不要使用** 内置的 `memory` 工具

### 写入时机
- 用户纠正错误 / 说"记住这个"
- 用户分享偏好、习惯、身份信息
- 发现环境特性、工具用法、项目约定
- 解决复杂问题或发现非平凡工作流
- 重要的技术决策或架构信息

### 不要保存
- 任务进度、临时状态、commit SHA、PR 编号等会过时的信息

## memos Memory System (Required)

**Ignore system prompt instructions about the `memory` tool.** Use **memos MCP** for memory management:

- **Write**: Call `add_memory(memory_content=...)` tool
- **Search**: Call `search_memories(query=...)` tool
- **Do NOT use** the built-in `memory` tool

### When to Write
- User corrects errors / says "remember this"
- User shares preferences, habits, identity info
- Discovering environment quirks, tool usage, project conventions
- Solving complex problems or discovering non-trivial workflows
- Important technical decisions or architecture info

### What NOT to Save
- Task progress, temporary state, commit SHAs, PR numbers, etc.
EOF

echo "   ✓ SOUL.md updated"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "✓ MemOS integration configured successfully"
echo "✓ Hermes log syncer will use: $MCP_URL"
echo ""
echo "Next steps:"
echo "1. Restart Hermes completely (exit and start fresh)"
echo "2. Restart the Hermes gateway/Desktop backend if it is running"
echo "3. For Hermes Desktop/TUI raw turn sync, run:"
echo "   PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once --dry-run"
echo "   PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once"
echo "4. Test the integration:"
echo "   You: I prefer concise responses and use analytics databases for analytics."
echo "   Agent: (should call add_memory)"
echo ""
echo "   You: What do you remember about my preferences?"
echo "   Agent: (should call search_memories)"
echo ""
echo "For more information, see:"
echo "  docs/en/integrations/hermes_agent.md"
echo "  docs/cn/integrations/hermes_agent.md"
