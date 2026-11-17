#!/usr/bin/env bash
# 一键在本机起项目记忆服务（MemOS + Neo4j 社区版 + Qdrant，项目记忆用自己的 SQLite），
# 起好后灌一遍样例数据（保留，便于查看）。可以重复执行：已有的镜像、.env、数据都会沿用。
#
#   bash docker/project-memory/start.sh              # 起服务 + 冒烟
#   bash docker/project-memory/start.sh --no-smoke   # 只起服务
#   bash docker/project-memory/start.sh --rebuild    # 重建底座镜像（改了 docker/requirements.txt 时）
#   bash docker/project-memory/start.sh --stop       # 停服务（数据在命名卷里，不删）
#
# 可用环境变量：ENV_SRC（模型 key 的来源，默认 MemOS_DEV/env_example）、SMOKE_SCENARIO（all/decision/experience）
# 兼容 macOS 自带的 bash 3.2。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENV_SRC="${ENV_SRC:-$REPO/../env_example}"
SMOKE_SCENARIO="${SMOKE_SCENARIO:-all}"
VENV="${PROMEM_VENV:-$HERE/.venv}"
BASE_URL="http://127.0.0.1:8000"
BASE_IMAGE="memos-base:promem"

SMOKE=1
REBUILD=0
STOP=0
for arg in "$@"; do
  case "$arg" in
    --no-smoke) SMOKE=0 ;;
    --rebuild) REBUILD=1 ;;
    --stop) STOP=1 ;;
    *) echo "不认识的参数：$arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
net_hint() {
  cat >&2 <<'EOF'

多半是网络问题（拉 Docker Hub 镜像或装 Python 包）。可以：
  - Docker Desktop → Settings → Docker Engine，加 "registry-mirrors"（公司或云厂商的镜像加速地址）；
  - 或 Settings → Resources → Proxies 配代理；
然后重新执行本脚本（已经下好的部分不会重下）。
EOF
}

# 找 compose：优先 `docker compose`（插件），其次独立的 docker-compose（v2），
# 再找 Docker Desktop / Homebrew 自带但没挂到 docker 插件目录上的 v2 二进制。
COMPOSE_BIN=""
find_compose() {
  if docker compose version >/dev/null 2>&1; then COMPOSE_BIN="docker compose"; return 0; fi
  local c brew_prefix=""
  command -v brew >/dev/null 2>&1 && brew_prefix="$(brew --prefix 2>/dev/null || true)"
  for c in \
    "$(command -v docker-compose 2>/dev/null || true)" \
    "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose" \
    "$HOME/.docker/cli-plugins/docker-compose" \
    "/usr/local/lib/docker/cli-plugins/docker-compose" \
    "/opt/homebrew/lib/docker/cli-plugins/docker-compose" \
    "${brew_prefix:+$brew_prefix/opt/docker-compose/bin/docker-compose}" \
    "$HOME/.orbstack/bin/docker-compose"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    local v
    v="$("$c" version --short 2>/dev/null || true)"
    case "$v" in
      v2.* | 2.* | v3.* | 3.*) COMPOSE_BIN="$c"; return 0 ;;
      1.*) echo "跳过 $c：版本 $v 太旧（需要 2.x）" ;;
    esac
  done
  return 1
}
compose_diag() {
  echo "── 诊断信息（贴给 Claude 也行）──"
  echo "docker：$(command -v docker)"
  docker version --format '客户端 {{.Client.Version}}；服务端 {{.Server.Version}}（{{.Server.Platform.Name}}）' 2>&1 || true
  echo "当前 context：$(docker context show 2>&1 || true)"
  echo "docker compose version 的报错："
  docker compose version 2>&1 | sed 's/^/  /' || true
  ls -l "$HOME/.docker/cli-plugins" 2>/dev/null | sed 's/^/  /' || echo "  ~/.docker/cli-plugins 不存在"
  [ -d /Applications/Docker.app ] && echo "装了 Docker Desktop：/Applications/Docker.app" || echo "没有 /Applications/Docker.app"
  command -v colima >/dev/null 2>&1 && echo "装了 colima"
  command -v orb >/dev/null 2>&1 && echo "装了 OrbStack"
  cat <<'EOF'
── 怎么装 compose（任选一种）──
  Homebrew：brew install docker-compose
  Docker Desktop：升级或重装到最新版（自带 compose）
装好后重新执行本脚本。
EOF
}
compose() {
  if [ "$COMPOSE_BIN" = "docker compose" ]; then
    docker compose -f "$HERE/docker-compose.yml" "$@"
  else
    "$COMPOSE_BIN" -f "$HERE/docker-compose.yml" "$@"
  fi
}

# ── 1. Docker ────────────────────────────────────────────────────────────────
step "1/6 检查 Docker"
command -v docker >/dev/null 2>&1 \
  || die "没找到 docker 命令：先安装 Docker Desktop（https://www.docker.com/products/docker-desktop/）并打开它"
docker info >/dev/null 2>&1 || die "Docker 没在运行：打开 Docker Desktop，等它显示 Engine running 后重试"
if ! find_compose; then
  compose_diag
  die "找不到可用的 docker compose（2.x）"
fi
echo "Docker 正常；compose：$COMPOSE_BIN（$(compose version --short 2>/dev/null || true)）"
if [ "$STOP" = "1" ]; then
  compose down
  exit 0
fi

# ── 2. 端口 ──────────────────────────────────────────────────────────────────
step "2/6 检查端口 8000 / 7474 / 7687 / 6333"
if command -v lsof >/dev/null 2>&1; then
  ours="$(docker ps --format '{{.Names}}' | grep -c '^memos-promem' || true)"
  for p in 8000 7474 7687 6333; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && [ "$ours" = "0" ]; then
      die "端口 $p 已被别的程序占用。用 lsof -nP -iTCP:$p -sTCP:LISTEN 看是谁，关掉后重试"
    fi
  done
  echo "端口可用"
else
  echo "没有 lsof，跳过端口检查"
fi

# ── 3. 本机脚本用的 Python 环境（只装 python-dotenv、httpx，放在独立 venv 里） ────────
step "3/6 准备本机 Python 环境"
command -v python3 >/dev/null 2>&1 || die "没找到 python3"
if ! "$VENV/bin/python" -c "import sys" >/dev/null 2>&1; then
  rm -rf "$VENV"
  python3 -m venv "$VENV" || die "建 venv 失败：$VENV"
fi
if ! "$VENV/bin/python" -c "import dotenv, httpx" >/dev/null 2>&1; then
  "$VENV/bin/python" -m pip install -q --disable-pip-version-check python-dotenv httpx \
    || { net_hint; die "装 python-dotenv / httpx 失败"; }
fi
PY="$VENV/bin/python"
echo "Python 环境：$VENV"

# ── 4. .env ──────────────────────────────────────────────────────────────────
step "4/6 准备 .env"
if [ -f "$REPO/.env" ] && grep -q '^PROJECT_MEMORY_GRAPH_DB=' "$REPO/.env"; then
  echo "沿用已有的 $REPO/.env（要重新生成就先删掉它）"
else
  [ -f "$ENV_SRC" ] || die "找不到模型 key 的来源文件 $ENV_SRC；用 ENV_SRC=/路径 bash $0 指定"
  if [ -f "$REPO/.env" ]; then
    bak="$REPO/.env.bak.$(date +%Y%m%d%H%M%S)"
    cp "$REPO/.env" "$bak"
    echo "原来的 .env 不是项目记忆部署用的，已备份到 $bak"
  fi
  "$PY" "$HERE/make_env.py" --env-file "$ENV_SRC" --out "$REPO/.env"
fi

# ── 5. 构建与启动 ────────────────────────────────────────────────────────────
step "5/6 构建镜像并启动容器"
if [ "$REBUILD" = "1" ] || ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "构建底座镜像 $BASE_IMAGE（第一次要装 120 多个 Python 包，几分钟到十几分钟）"
  (cd "$REPO" && docker build -f docker/Dockerfile -t "$BASE_IMAGE" .) \
    || { net_hint; die "底座镜像构建失败"; }
fi
compose up -d --build || { net_hint; die "docker compose up 失败"; }

printf '等服务就绪'
healthy=0
for _ in $(seq 1 120); do
  if curl -fsS -m 3 "$BASE_URL/health" >/dev/null 2>&1; then healthy=1; break; fi
  printf '.'
  sleep 3
done
echo
if [ "$healthy" != "1" ]; then
  compose ps || true
  compose logs --tail 60 memos || true
  die "6 分钟内 $BASE_URL/health 没有响应，日志见上（或把上面的输出贴给 Claude）"
fi
echo "服务已就绪：$(curl -fsS -m 3 "$BASE_URL/health")"

# ── 6. 冒烟（保留数据） ──────────────────────────────────────────────────────
if [ "$SMOKE" = "1" ]; then
  step "6/6 灌样例数据并检查（真实模型，约 3–5 分钟）"
  "$PY" "$HERE/smoke.py" --base "$BASE_URL" --scenario "$SMOKE_SCENARIO" --keep \
    || echo "冒烟有不通过项，见上面的 ✗ 行"
else
  step "6/6 跳过冒烟（--no-smoke）"
fi

cat <<EOF

────────────────────────────────────────────────────────────
服务在跑：
  接口文档（可直接在网页上调）  $BASE_URL/docs
  健康检查                      $BASE_URL/health
  Neo4j 浏览器（核心记忆）      http://localhost:7474   账号 neo4j / projectmemory
  Qdrant 面板（核心向量）       http://localhost:6333/dashboard
看日志：$COMPOSE_BIN -f "$HERE/docker-compose.yml" logs -f memos
停服务：bash "$HERE/start.sh" --stop
────────────────────────────────────────────────────────────
EOF
