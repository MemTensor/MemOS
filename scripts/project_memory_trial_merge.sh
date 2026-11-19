#!/usr/bin/env bash
# 项目记忆合入企业版的守门脚本：把开源分支试合进企业版的临时克隆，报告越界改动与冲突。
# 两个仓库都不改（企业版用 --shared 克隆到临时目录，开源只读 fetch）。
#
# 用法：
#   bash scripts/project_memory_trial_merge.sh <企业版仓库> <开源仓库> \
#        [开源分支=promem_dev] [开源基线=dev-v2.0.36] [企业版分支=origin/dev-v2.0.36.post]
# 退出码：0 无冲突且没有越界；1 有冲突；2 动了冻结名单之外的共享文件；3 企业版分支找不到
#
# 规则：项目记忆的业务代码只放在 OWN_PREFIXES 里的新文件；共享文件只许按 FROZEN_TOUCHPOINTS
# 后面注明的方式改（这些位置两版逐字相同或企业版没动过，合并时能自动合入）。
set -euo pipefail

EE=${1:?企业版仓库路径}
OS=${2:?开源仓库路径}
BR=${3:-promem_dev}
BASE_BR=${4:-dev-v2.0.36}
EE_REF=${5:-origin/dev-v2.0.36.post}

FROZEN_TOUCHPOINTS=(
  pyproject.toml                                       # 插件入口点 project_memory；ruff per-file-ignores
  src/memos/api/product_models.py                      # 一行 import；三个类头加 mixin；DeleteMemoryRequest 末尾 space_id
  src/memos/api/routers/server_router.py               # get_memory / get_memory/{id} / delete_memory / scheduler_status 的 project 分支
  src/memos/plugins/hooks.py                           # hookable 的 {name}.intercept（插件框架通用能力）
  src/memos/api/handlers/search_handler.py             # 相关度门槛之后一行：插件登记的结果类别过同一道门槛
  src/memos/plugins/hook_defs.py                       # PROJECT_MEMORY_* 钩子声明（含可选的 LOCK）
  src/memos/mem_scheduler/task_schedule_modules/registry.py  # 登记 project_memory handler
  src/memos/graph_dbs/base.py                          # ConcurrentUpdateError
  src/memos/graph_dbs/factory.py                       # 注册 sqlite
  src/memos/configs/graph_db.py                        # SQLiteGraphDBConfig
  src/memos/types/openai_chat_completion_types/chat_completion_user_message_param.py       # role_id / role_name 与企业版逐字相同
  src/memos/types/openai_chat_completion_types/chat_completion_system_message_param.py     # 同上
  src/memos/types/openai_chat_completion_types/chat_completion_assistant_message_param.py  # 同上 + experience_notes（refusal 之后）
)
OWN_PREFIXES=(
  src/memos/project_memory/
  src/memos/api/project_fields.py
  src/memos/api/handlers/project_view.py
  src/memos/plugins/result_kinds.py
  src/memos/graph_dbs/sqlite.py
  src/memos/mem_scheduler/task_schedule_modules/handlers/project_memory_handler.py
  tests/project_memory/
  examples/project_memory/
  docker/project-memory/
  scripts/project_memory_trial_merge.sh
)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q --shared --no-checkout "$EE" "$TMP/ee"
cd "$TMP/ee"
git config user.email ci@local
git config user.name ci
# 本地克隆只带过来对方的本地分支，对方的远端跟踪分支要单独取
git fetch -q "$EE" 'refs/remotes/origin/*:refs/remotes/origin/*' 'refs/heads/*:refs/remotes/local/*'
git rev-parse -q --verify "$EE_REF" >/dev/null || { echo "企业版里找不到 ${EE_REF}"; exit 3; }
git checkout -q -b trial "$EE_REF"
git fetch -q "$OS" "${BR}:os_br" "${BASE_BR}:os_base"

echo "== 1. 企业版 ${EE_REF} 先合开源基线 ${BASE_BR}（与项目记忆无关的冲突在这一步暴露）"
if git merge-base --is-ancestor os_base HEAD; then
  echo "  基线已在企业版里"
elif ! git merge -q --no-edit os_base >/dev/null 2>&1; then
  echo "  开源基线本身与企业版有冲突（不归项目记忆）："
  git diff --name-only --diff-filter=U
  exit 1
fi

echo "== 2. 越界检查：${BR} 相对 ${BASE_BR} 动了哪些共享文件"
status=0
while read -r f; do
  own=0
  for p in "${OWN_PREFIXES[@]}"; do [[ "$f" == "$p"* ]] && own=1; done
  [[ $own == 1 ]] && continue
  allowed=0
  for p in "${FROZEN_TOUCHPOINTS[@]}"; do [[ "$f" == "$p" ]] && allowed=1; done
  if [[ $allowed == 0 ]]; then echo "  越界：$f"; status=2; fi
done < <(git -c core.quotepath=off diff --name-only os_base os_br)
[[ $status == 0 ]] && echo "  无越界"

echo "== 3. 再合 ${BR}"
if git merge -q --no-edit os_br >/dev/null 2>&1; then
  echo "  无冲突"
else
  echo "  冲突："
  git diff --name-only --diff-filter=U | while read -r f; do
    echo "    $(grep -c '^<<<<<<<' "$f") 处  $f"
  done
  exit 1
fi
exit $status
