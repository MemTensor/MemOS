#!/usr/bin/env bash
# E2E probe — simulate a realistic Python-coding conversation against
# a running viewer and print per-layer counts so the user can verify
# that capture / reward / induction / crystallisation all produced
# something.
#
# Usage:
#   bash apps/memos-local-plugin/scripts/e2e-probe.sh \
#        [--url http://127.0.0.1:18799] \
#        [--password YOUR_PASS]
#
# What it does:
#   1. Authenticates (optional — only if the viewer has a password set)
#   2. Snapshots current counts (traces / tasks / experiences / skills /
#      environment-knowledge / api-logs)
#   3. Runs five synthetic turns of a Python coding task through
#      `POST /api/v1/diag/simulate-turn?allow=1`
#   4. Waits for async pipelines (capture / reward / induction) to settle
#   5. Snapshots counts again and prints a delta table
#
# You can then open http://127.0.0.1:18799/ and see the new rows in
# each UI tab.

set -euo pipefail

URL="${URL:-http://127.0.0.1:18799}"
PASSWORD=""
COOKIE_FILE="$(mktemp)"
trap 'rm -f "$COOKIE_FILE"' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
die() { echo "✗ $*" >&2; exit 1; }
log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

have curl || die "curl is required"
have jq   || die "jq is required (brew install jq / apt-get install jq)"

log "Probing viewer at $URL"
HEALTH="$(curl -sf "$URL/api/v1/health" || true)"
if [[ -z "$HEALTH" ]]; then
  die "viewer is not reachable — is the plugin running?"
fi
AGENT="$(echo "$HEALTH" | jq -r '.agent // "unknown"')"
ok "Viewer alive (agent=$AGENT)"

# ─── Auth ──────────────────────────────────────────────────────────
STATUS="$(curl -sf -c "$COOKIE_FILE" "$URL/api/v1/auth/status")"
NEEDS_SETUP="$(echo "$STATUS" | jq -r '.needsSetup // false')"
ENABLED="$(echo "$STATUS" | jq -r '.enabled // false')"
if [[ "$NEEDS_SETUP" == "true" ]]; then
  [[ -n "$PASSWORD" ]] || die "first-run setup required — rerun with --password YOURPASS"
  log "First-run: setting password"
  curl -sf -c "$COOKIE_FILE" -X POST "$URL/api/v1/auth/setup" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg p "$PASSWORD" '{password:$p}')" > /dev/null
  ok "Password set + session cookie stored"
elif [[ "$ENABLED" == "true" ]]; then
  [[ -n "$PASSWORD" ]] || die "viewer locked — rerun with --password YOURPASS"
  log "Logging in"
  curl -sf -c "$COOKIE_FILE" -X POST "$URL/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg p "$PASSWORD" '{password:$p}')" > /dev/null
  ok "Logged in"
fi

# ─── Baseline snapshot ─────────────────────────────────────────────
snapshot() {
  curl -sf -b "$COOKIE_FILE" "$URL/api/v1/diag/counts"
}
BEFORE="$(snapshot)"
log "Baseline: $(echo "$BEFORE" | jq -c '.')"

# ─── Simulate a Python-coding conversation ─────────────────────────
simulate() {
  local user="$1" assistant="$2"
  local tcalls_json="${3:-[]}"
  curl -sf -b "$COOKIE_FILE" \
    -X POST "$URL/api/v1/diag/simulate-turn?allow=1" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg agent "$AGENT" \
      --arg user "$user" \
      --arg assistant "$assistant" \
      --argjson tc "$tcalls_json" \
      '{agent:$agent, user:$user, assistant:$assistant, toolCalls:$tc}')" \
    > /dev/null
}

log "Turn 1 — intent: write a function"
simulate \
  "帮我写一个 Python 函数，读 CSV 并返回每列的平均值。" \
  "好的。我建议用 pandas 的 read_csv + DataFrame.mean。下面是实现： …(代码略)…"

log "Turn 2 — follow-up: add error handling"
simulate \
  "如果文件不存在或者列不是数字怎么办？" \
  "我加上 try/except FileNotFoundError 和 numeric_only=True。新版本： …"

log "Turn 3 — user confirms it works"
simulate \
  "跑通了，谢谢" \
  "不客气。如有需要可以再让我加个单元测试。"

log "Turn 4 — similar task (should trigger experience → policy reuse)"
simulate \
  "再帮我写一个类似的，读 JSON 并返回每字段的非空占比。" \
  "我复用刚才的模式：json.load + pandas + notna().mean()。代码： …"

log "Turn 5 — user gives negative feedback → should surface as takeaway"
simulate \
  "不要用 pandas，我只想用标准库" \
  "明白。我改用内置 json + collections 重写： …" \
  '[{"name":"python_exec","input":{"cmd":"python"},"output":"ok"}]'

ok "5 synthetic turns submitted"
log "Waiting 12s for reward backprop + L2 induction + skill crystallisation…"
sleep 12

# ─── After snapshot + delta ────────────────────────────────────────
AFTER="$(snapshot)"
log "After: $(echo "$AFTER" | jq -c '.')"

delta() {
  local k="$1"
  local b a
  b="$(echo "$BEFORE" | jq -r --arg k "$k" '.[$k] // 0')"
  a="$(echo "$AFTER"  | jq -r --arg k "$k" '.[$k] // 0')"
  printf '  %-14s %6s  →  %-6s  Δ%+d\n' "$k" "$b" "$a" "$((a - b))"
}

echo
echo "============================================================"
echo " V7 layer delta (baseline → after)"
echo "============================================================"
delta traces          # L1 conversation memory
delta episodes        # tasks
delta apiLogs         # /logs page entries
delta policies        # L2 experiences
delta worldModels     # L3 environment knowledge
delta skills          # crystallised skills
echo "============================================================"
echo
echo "Open $URL/ to see the new rows in each tab:"
echo "  Memories   → $URL/#/memories"
echo "  Tasks      → $URL/#/tasks"
echo "  Experiences→ $URL/#/policies"
echo "  Env knowl. → $URL/#/world-models"
echo "  Skills     → $URL/#/skills"
echo "  Logs       → $URL/#/logs"
echo
echo "Note: policies / world models / skills only crystallise when"
echo "the configured Summarizer + Skill-Evolver models produce"
echo "high-confidence reflections. If they stay at 0, configure real"
echo "LLM keys in Settings → AI models and re-run this probe."
