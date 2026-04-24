# Reflect2Evolve V7 — TaskCLI 真实项目测试

> 用一个**真实的 Python 命令行项目**（`task-cli`：极简任务管理工具）测试 V7 算法的完整沉淀链路与三层检索：
> **L1 记忆 → L2 经验归纳 → L3 环境认知 → Skill 结晶 / 升级 → 三层检索注入**。
>
> 本剧本不只是"演示算法层级"，而是**让你实际通过 OpenClaw 增量构建一个可运行的 Python 项目**，借由"自然的开发节奏"自动覆盖本地插件的所有能力，并在最后一轮明确**召回此前生成到本项目里的代码 / 测试 / 项目结构**——形成完整的"先生成、后召回到同一个项目"的闭环。
>
> 全程使用 `openclaw agent` 命令行 + 浏览器打开 `http://127.0.0.1:18799`。
> 共 **9 轮交互 + 1 轮收官三层召回**，全程约 25 分钟。
>
> 阅读建议：先读 [`Reflect2Skill_算法设计核心.md`](./Reflect2Skill_算法设计核心.md) 0 节与 2.6 节，再读 [`DEMO_OpenClaw_Python_演示.md`](./DEMO_OpenClaw_Python_演示.md)，再读本文。
>

---

## 0. 这个项目要做成什么样

我们要让 OpenClaw 帮我们把 `task-cli` 项目从空目录开始，一步一步建起来：

```
task-cli/
├── pyproject.toml
├── README.md
├── task_cli/
│   ├── __init__.py
│   ├── core/
│   │   ├── __init__.py
│   │   └── models.py            # Task 数据类
│   ├── storage/                 # 存储层 —— 子问题模式 #1（多种格式）
│   │   ├── __init__.py
│   │   ├── json_store.py        # Round 1
│   │   ├── yaml_store.py        # Round 2
│   │   └── sqlite_store.py      # Round 3
│   ├── commands/                # CLI 命令层 —— 子问题模式 #3（多个动词）
│   │   ├── __init__.py
│   │   ├── add.py               # Round 7
│   │   └── list.py              # Round 8
│   └── main.py
└── tests/                       # pytest 测试 —— 子问题模式 #2
    ├── conftest.py
    ├── test_json_store.py       # Round 4
    ├── test_yaml_store.py       # Round 5
    └── test_sqlite_store.py     # Round 6
```

**关键设计**：每一组子目录都被设计成**"重复但不同"的子任务族**——这恰好是 V7 跨任务 L2 归纳的食材。

| 子任务族 | 重复体现 | 不同体现 | 触发的 V7 现象 |
|---|---|---|---|
| `storage/*_store.py` | 都做"读路径→反序列化→返回 list[Task]" + 异常处理 + UTF-8 | 序列化格式不同（json / yaml / sqlite） | **L2 经验 #1**：存储读写策略 |
| `tests/test_*.py` | 都用 `pytest + tmp_path + fixture`，覆盖 ✅正常/❌路径不存在/❌格式错误 | 被测目标不同 | **L2 经验 #2** + **Skill 首次结晶 + 升级** |
| `commands/*.py` | 都接 `argparse subparser`，调 storage，处理 user-friendly error | CLI 动词不同（add / list） | **L2 经验 #3** |

**最终目标**：在 Round 10（收官轮），让 OpenClaw 给项目加一个**新格式 Parquet 存储**，并要求"按现有项目的结构、约定、风格做"。这一轮会**同时召回**前 9 轮沉淀进本地插件的：

- **Tier 1 技能**：从 pytest 经验结晶出的 skill
- **Tier 2 记忆**：之前写过的 storage / pytest 代码片段
- **Tier 3 环境认知**：项目目录结构、命名约定、约束

并把它们注入到 prompt，由 OpenClaw 直接产出风格一致的代码——**这就是"生成→召回到同一个编程项目"的完整闭环**。

---

## 1. 演示前准备

### 1.1 工作目录（重要：必须在 OpenClaw 的 agent workspace 内）

`openclaw agent` 子命令的工作目录绑定在它所属 agent 的 `workspace` 配置上（默认 `~/.openclaw/workspace/`），你的 demo 项目目录**必须放在这个 workspace 之内**，agent 才有写盘权限：

```bash
mkdir -p ~/.openclaw/workspace/task-cli
ls -la ~/.openclaw/workspace/task-cli   # 应该是空目录
```

> 如果你已经把 OpenClaw 配成了别的 workspace（看 `~/.openclaw/openclaw.json` 里 `agents.defaults.workspace`），把上面路径换成 `<your-workspace>/task-cli` 即可。每一轮 query 都会在 message 里**显式写出绝对路径** `~/.openclaw/workspace/task-cli/`，这是 L3 环境认知能"沉淀出项目结构"的前提。

### 1.2 确认 OpenClaw 与插件

```bash
# 确认 plugin 已加载（注意：openclaw plugins list 命令偶尔会卡 hub 同步，不必等它返回）
curl -s http://127.0.0.1:18799/api/v1/health | python3 -m json.tool

# 应能看到：
#   "agent": "openclaw"
#   "version": "2.0.0-beta.1"
#   "llm.available": true
#   "embedder.available": true
#   "skillEvolver.available": true
```

浏览器打开 `http://127.0.0.1:18799` 看面板。

### 1.3 配置真实 LLM Key（必填）

进入 **设置 → AI 模型**，三个卡片必须都"测试"通过：

| 卡片 | 推荐模型 | 不配的后果 |
|---|---|---|
| 嵌入模型 | bge-m3 / text-embedding-3-large | Tier 2 / Tier 3 召回完全失效 |
| 摘要模型 | gpt-4o-mini / claude-haiku **（非思考型）** | **不会生成任何经验和技能** |
| 技能结晶模型 | gpt-5-thinking / claude-sonnet **（思考型）** | 留空沿用摘要模型，技能质量下降 |

### 1.4 (可选) 应用 demo 阈值降配

> 2026-04 后，生产默认阈值已经下调到"普通用户 1 周内能看到首条 L3/Skill"的水平，所以**这一步对正常使用者来说不再必须**。
> 但 demo 想在 9 轮里把所有层级跑出来，需要进一步压低 `minSupport / candidateTrials / minGain` 等阈值。

参照 [`templates/config.demo.yaml`](../templates/config.demo.yaml) 把里面的 `algorithm.*` 块手动 merge 进 `~/.openclaw/memos-plugin/config.yaml`（**不会被 install.sh 自动安装**，需要你手动复制），然后 `openclaw gateway restart`。

> ⚠️ **字段名注意**：schema 字段是 **`candidateTrials`**，不是 `probationaryTrials`（早期 README 误写）；后者会被 schema 静默忽略，状态仍然按 default=3 走。

### 1.5 清空旧数据（推荐用 admin API，别手撕 SQL）

直接 `DELETE FROM` 会撞上 SQLite FTS5 shadow table 的 defensive 模式（`Parse error: unsafe use of virtual table`）。**正确做法**：调插件提供的 `admin/clear-data` 端点，它会关 core → 删 db 文件 → 触发自身退出 → 由 plugin host 自动重启重建 schema：

```bash
# 取得 viewer session cookie（demo 模式下密码保护若已开启）
SESS=$(python3 -c "
import json,hmac,hashlib,base64,os
s=json.load(open(os.path.expanduser('~/.openclaw/memos-plugin/.auth.json')))
body=base64.urlsafe_b64encode(json.dumps({'iat':0,'exp':9999999999999}).encode()).decode().rstrip('=')
mac=base64.urlsafe_b64encode(hmac.new(base64.b64decode(s['sessionSecret']), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
print(body+'.'+mac)
")
echo "$SESS" > /tmp/memos_sess.txt

# 让插件清库 + 自动退出（plugin host 会拉起一个新进程）
curl -s -b "memos_sess=$SESS" -X POST http://127.0.0.1:18799/api/v1/admin/clear-data \
  -H 'content-type: application/json' -d '{}'
sleep 4

# 主动重启 gateway 把 viewer 也带起来
openclaw gateway restart 2>&1 | head -2
sleep 12

# 重铸 cookie（sessionSecret 在 admin clear 后会换新）
SESS=$(python3 -c "
import json,hmac,hashlib,base64,os
s=json.load(open(os.path.expanduser('~/.openclaw/memos-plugin/.auth.json')))
body=base64.urlsafe_b64encode(json.dumps({'iat':0,'exp':9999999999999}).encode()).decode().rstrip('=')
mac=base64.urlsafe_b64encode(hmac.new(base64.b64decode(s['sessionSecret']), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
print(body+'.'+mac)
")
echo "$SESS" > /tmp/memos_sess.txt

# 重置工作目录
rm -rf ~/.openclaw/workspace/task-cli && mkdir -p ~/.openclaw/workspace/task-cli

# 验证一切归零
sqlite3 ~/.openclaw/memos-plugin/data/memos.db \
  "SELECT (SELECT COUNT(*) FROM traces)||'t '||(SELECT COUNT(*) FROM episodes)||'e '||(SELECT COUNT(*) FROM policies)||'p '||(SELECT COUNT(*) FROM world_model)||'w '||(SELECT COUNT(*) FROM skills)||'s';"
# 期望：0t 0e 0p 0w 0s
```

刷新面板，五个总览数字应全部为 0。

### 1.6 关键操作纪律（**与传统 demo 文档不同，这里是 2026-04 实测后修订版**）

#### 1.6.1 全程使用同一个 `--session-id`

**这是 demo 能跑通的关键。** OpenClaw 的 `relation-classifier` 只在「同 session 内 prev_user_text 存在」时才会比对前一轮跟当前轮的关系：

- ✅ 同 session-id + LLM 判 `new_task` → 正确关闭上一轮 episode → 触发 reward chain → V 回填 → L2/L3/Skill 才有食材
- ❌ 每轮换 session-id（早期 demo 文档的写法） → 每轮都是 bootstrap、永远走不到 `new_task` 分支 → episode 永远停在 `open`、`r_task = NULL`、所有 V = 0、整个进化链路死掉

本剧本**全程使用 session-id `task-cli-demo`**。

#### 1.6.2 每轮 query 以「换个任务：」精确打头（首轮除外）

`relation-classifier.ts` 里的 r5 强启发式 regex 是 `/换个(话题|问题|任务|主题|场景)/i`（2026-04 后还允许中间插 1-5 字符）。命中即直接返回 `new_task @ 0.85` 强信号、跳过 LLM 判断；不命中则走 LLM 兜底，而 LLM 看到"两轮都在搞同一个 task-cli 项目的 storage"必然判 follow_up，episode 不会切，链路又卡死。

模板：

```
"换个任务：<新一轮的具体诉求>"
```

#### 1.6.3 OpenClaw 自身的 session 历史也要清

清库时**只清了 plugin 数据库**，OpenClaw 主体仍然保留对 `task-cli-demo` 这个 session 的对话历史（在它自己的 storage 里）。如果你重新清库后又用同一 session-id，agent 会"记得"之前已经做过项目，给出"已存在，是否重建？"这种诡异回答。

**做法**：每次重置后，**用一个新的 session-id**（比如 `task-cli-demo-v2` / `-v3`），保证 OpenClaw 自身 session 也是空白起步。本剧本下面所有命令使用 `task-cli-demo-v6`，你跑的时候自己改个新 suffix 即可。

#### 1.6.4 命令收尾纪律

- 命令返回 `"stopReason": "stop"` 后**手动 Ctrl+C**（agent 会进入 hub retry 循环，不会自动退出）
- 每轮 Ctrl+C 后**等 40-60 秒**让 capture / reward / L2 / L3 / skill 订阅者收尾，再去面板验证
- **召回看日志页**：每轮 `memory_search` 卡片展开后有「初步召回 / Hub 远端 / LLM 筛选后」三段，被注入 assistant 的就是「LLM 筛选后」

---

## 2. 阶段 A — 数据层（3 轮，触发 L1 + L2 经验 #1 + Tier 2 召回）

> 这一阶段我们让 OpenClaw 写**三种格式的存储后端**。三个任务"长得像但不一样"，这是跨任务 L2 归纳的标准触发条件。

### Round 1 · JSON 存储（L1 起点 + 冷启动空召回）

```bash
SESSION="task-cli-demo-v6"   # ← 全程用这个 session-id

openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'在 ~/.openclaw/workspace/task-cli/ 这个全新空目录下从零搭一个 Python 任务管理 CLI 项目（task-cli），现有目录是空的。第一步：在 task-cli/task_cli/storage/json_store.py 里写一个 JSONStore 类，提供 load(path: str) -> list[dict] 和 save(path: str, tasks: list[dict]) -> None 两个方法。约束：(1) 所有方法带 docstring + 类型注解；(2) load 在文件不存在时抛 FileNotFoundError 并附中文提示；(3) JSON 解析失败时抛带行号的 ValueError；(4) 强制 UTF-8 编码；(5) save 用 indent=2、ensure_ascii=False。同时给出 task-cli/task_cli/core/models.py 里 Task dataclass 的最小定义（id: int, title: str, done: bool=False）。请实际把文件创建到磁盘上（包括必要的 __init__.py），并简要确认创建结果。'
```

> 看到 `"stopReason": "stop"` 后 Ctrl+C，等 45 秒。

**面板检查**

| 面板 | 期望 |
|---|---|
| 总览 | 记忆=10±5，任务=1（episode 仍 `open`，等下一轮 `new_task` 才 close） |
| 记忆 | 多条 step trace（一次 tool call 一条 trace + 一条总结 trace） |
| 任务 | 1 个**进行中**的 episode，r_task 暂时 null |
| 经验 / 环境认知 / 技能 | 0 |
| 日志 → `memory_search` | **「初步召回」为空** `candidates: []` —— 完美的"冷启动空召回" |
| 日志 | `memory_add` + `memory_search` 各 1 条 |

> ✅ 这一步演示了 **L1 trace 写入 + 反思加权 V 框架已就位**。注意 V/α 此刻仍然是 0，要等 Round 2 的 `new_task` 信号触发 R1 的 reward 评分后才回填。

**动手**：检查 `~/.openclaw/workspace/task-cli/` 下应该已经出现 `task_cli/storage/json_store.py`、`task_cli/core/models.py` 和必要的 `__init__.py`。

---

### Round 2 · YAML 存储（**触发 R1 episode close + 跨任务 L2 归纳**）

```bash
openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'换个任务：在 ~/.openclaw/workspace/task-cli/ 项目里继续完善：在 task-cli/task_cli/storage/yaml_store.py 里写一个 YAMLStore 类，提供和 JSONStore 完全相同的接口：load(path: str) -> list[dict] 和 save(path: str, tasks: list[dict]) -> None。底层用 PyYAML：load 用 yaml.safe_load，save 用 yaml.safe_dump(allow_unicode=True, sort_keys=False)。约束完全一致：docstring + 类型注解；文件不存在抛 FileNotFoundError 中文提示；解析失败抛友好 ValueError；强制 UTF-8。请实际把文件创建到磁盘上并简要确认。'
```

> Ctrl+C，等 50 秒。

**面板检查**

| 面板 | 期望 |
|---|---|
| 总览 | 记忆≈17，任务=2（**R1 现在已 closed，r_task ≈ 0.75**） |
| 任务 → R1 episode | status=closed、r_task≈0.75、relation 字段填了 `new_task` |
| 记忆 → R1 阶段 trace | V/α 已经被回填（V 大致 0.5-0.85） |
| 日志 | 新增 `task_done` 1 条 |
| 经验 / 环境认知 / 技能 | 仍可能为 0（首次跨任务归纳常会卡在 `candidate`，gain 接近 0） |

> ✅ **第一次 episode close + reward chain 跑通**。如果 v6 阈值（demo template）已应用，这一轮就可能看到第 1 条 L2 policy `candidate` 状态出现；用生产默认值则常常要到 R3-R4 才看到。

---

### Round 3 · SQLite 存储（**第一次 Tier 2 记忆召回**）

```bash
openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'换个任务：在 ~/.openclaw/workspace/task-cli/ 项目里继续完善存储层：在 task-cli/task_cli/storage/sqlite_store.py 里写一个 SQLiteStore 类，接口和 JSONStore / YAMLStore 完全一致：load(path: str) -> list[dict] 和 save(path: str, tasks: list[dict]) -> None。底层用 sqlite3 标准库：表名 tasks，字段 (id INTEGER PK, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)。约束：docstring + 类型注解；数据库文件不存在时不要抛错；表结构损坏时抛友好 RuntimeError；强制 UTF-8 文本；save 用事务保证原子性。请实际把文件创建到磁盘上并简要确认。'
```

> Ctrl+C，等 55 秒。

**面板检查**

| 面板 | 期望 |
|---|---|
| 任务 → R2 episode | status=closed、r_task≈0.75 |
| 经验 | 第 1 条 L2 policy 应已出现（可能 `candidate`，可能升 `active`，看阈值） |
| **日志 → `memory_search`** | **第一次出现 Tier 2 trace 召回！**「初步召回」里有 R1/R2 的 storage 实现 trace，score 0.7+，「LLM 筛选后」保留并**注入 prompt** |

> ✅ **生成→召回闭环的第一次显形**：R1/R2 写盘的代码被 Tier 2 召回，进入 R3 的 prompt——assistant 写 SQLite 时能直接参考之前的 storage 风格。

---

## 3. 阶段 B — 测试层（3 轮，触发 L2 经验 #2 + Skill 首次结晶 + Skill 升级）

> 切换到**完全不同的子问题模式**（写测试 vs 写存储），但仍在同一个项目领域。这会产生第 2 条 L2 policy，并触发 Skill 首次结晶。

### Round 4 · 给 JSON Store 写 pytest

```bash
openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'换个任务：现在切到测试层。在 ~/.openclaw/workspace/task-cli/ 项目里，给 task_cli/storage/json_store.py 写 pytest 单元测试，放到 tests/test_json_store.py。约束：用 tmp_path fixture；至少覆盖三种情况：✅正常 round-trip、❌load 不存在的路径抛 FileNotFoundError、❌load 一个非法 JSON 文件抛 ValueError；顺手给 tests/conftest.py 一个 sample_tasks fixture 返回 3 条样例数据。请把文件创建到磁盘上并简要确认。'
```

> Ctrl+C，等 55 秒。

**面板检查**

| 面板 | 期望 |
|---|---|
| 任务 | R3 closed、R4 open |
| 经验 | 在 demo 配置下，多半已出现 1-2 条 active policy；生产配置可能仍 candidate |

---

### Round 5 · 给 YAML Store 写 pytest（**触发第 2 条 L2 + Skill 首次结晶**）

```bash
openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'换个任务：继续给 ~/.openclaw/workspace/task-cli/ 项目写测试。给 task_cli/storage/yaml_store.py 写 pytest 单元测试，放到 tests/test_yaml_store.py。约束和 JSON 测试一致：tmp_path fixture；覆盖 ✅正常 round-trip、❌路径不存在抛 FileNotFoundError、❌非法 YAML 抛 ValueError；保持和 test_json_store.py 一致的命名风格 test_<scenario>。请把文件创建到磁盘上并简要确认。'
```

> Ctrl+C，等 60 秒。

**面板检查**

| 面板 | 期望 |
|---|---|
| 经验 | 出现第 2 条 L2 policy（pytest / 存储测试模式） |
| **技能** | **新增 1 条 `validate_*` / `pytest_*` 类 skill**，status=`candidate`，η ≈ 0.5 |
| 技能详情 → 进化时间线 | 「开始结晶」→「结晶完成」 |
| 日志 | `policy_generate` + `skill_generate` |

> ✅ **演示第一个高潮**：两条不同领域的经验同时存在，且 pytest 经验立即结晶出第一条可调用技能。

> ⚠️ Skill verifier 在 2026-04 之前对**中文 evidence 总是返回 `resonance=0`** 导致结晶被拒。verifier 已加 CJK bigram 支持；如果你看到 gateway.err.log 里出现 `skill.verify.fail reason=resonance-low`，确认部署的 `core/skill/verifier.ts` 包含 CJK 支持。

---

### Round 6 · 给 SQLite Store 写 pytest（**Tier 1 技能召回 + 可能的 Skill 升级**）

```bash
openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'换个任务：继续给 ~/.openclaw/workspace/task-cli/ 项目写测试。给 task_cli/storage/sqlite_store.py 写 pytest 单元测试，放到 tests/test_sqlite_store.py。约束：tmp_path fixture（用 tmp_path / "tasks.db" 当数据库路径）；覆盖 ✅正常 round-trip、✅首次创建数据库不抛错、❌人为破坏文件后 load 抛友好 RuntimeError；保持和 test_json_store.py / test_yaml_store.py 一致的命名风格 test_<scenario>。请把文件创建到磁盘上并简要确认。'
```

> Ctrl+C，等 65 秒。

**面板检查**

| 面板 | 期望 |
|---|---|
| 经验 | pytest policy `support` 升到 3 |
| 技能 | 可能 version 升到 2（rebuild），eta 上调 |
| **日志 → `memory_search`** | **Tier 1 技能召回首次出现** —— 「初步召回」第一条是 Skill：`validate_python_syntax_compile (η=0.5)`，技能 invocation guide 注入 prompt |

> ✅ **演示第二个高潮**：技能召回首次接管任务，OpenClaw 直接照已结晶的 pytest 模板写。

> ⚠️ **L3 环境认知**目前在生产算法路径下不一定能从这一步自动生成（cluster 主题相似度 + cooldown），见 §9.3 的 manual seed 兜底方案。

---

## 4. 阶段 C — 命令层（2 轮，新增第 3 条经验，丰富项目结构）

### Round 7 · `task add` 子命令

```bash
openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'换个任务：在 ~/.openclaw/workspace/task-cli/ 项目里加 CLI 入口。task_cli/main.py 里用 argparse 注册一个 task 父命令 + subparsers；task_cli/commands/add.py 实现 task add <title> 子命令：从 ~/.task-cli/tasks.json 读已有任务（用 JSONStore），追加一条 id 自增的新任务，写回去；找不到文件就当空列表起步。约束：register(subparsers) 注册命令；handler() -> int；带 docstring + 类型注解；中文友好错误提示。请把文件创建到磁盘上并简要确认。'
```

> Ctrl+C，等 55 秒。

---

### Round 8 · `task list` 子命令（**触发第 3 条 L2 经验**）

```bash
openclaw agent --session-id "$SESSION" --timeout 120 --json --message \
'换个任务：继续在 ~/.openclaw/workspace/task-cli/ 项目里加 CLI 子命令。task_cli/commands/list.py 实现 task list 子命令：从 ~/.task-cli/tasks.json 读所有任务，按 id 升序打印；支持 --done / --pending 互斥参数过滤；空列表时打印中文提示「暂无任务」。约束保持和 add.py 一致：register(subparsers) + handler() -> int + docstring + 类型注解 + 中文友好错误。请把文件创建到磁盘上并把它接到 main.py 的 subparsers 上，简要确认。'
```

> Ctrl+C，等 60 秒。

**面板检查**

| 面板 | 期望 |
|---|---|
| 总览 | 经验 ≥ 2 active（cli command 是否升 active 看阈值），world_model 仍可能 = 0 |

---

## 5. 阶段 D — 收官·三层同时召回（独立 R10）

> 这是整个剧本的灵魂。前 9 轮（含 R1 的 bootstrap）都用同一个 session-id 持续追加；这一轮我们**故意换一个新的 session-id**（避免 OpenClaw 主体 session 把之前的对话直接喂给 LLM，让 plugin 召回成为唯一的"前情提要"通道），构造一个 query 同时打中三层关键词。

### 5.1 收官前的预检

> ⚠️ **如果 L3 还没自动生成**：在 9 轮短窗口下，能否自动生成出一条 L3 取决于 LLM 在 R5/R6 归纳出的 policy 主题是否足够接近（vec cosine ≥ 0.6）。这是**短 demo 跟 LLM 归纳运气的矛盾**，不是算法不能跑——真实使用场景下用户跑 1-2 周后，同领域 active policy 自然会积累到主题相近的程度（而且 demo 模板把 `clusterMinSimilarity` 调到 0.5 已经放宽不少）。
>
> 如果你这一轮 demo 没自动出 L3，按 §9.3 手工 seed 一条 world_model + WAL checkpoint，然后再继续。**没有 world_model 就看不到三层召回**。

确认三层数据都齐：

```bash
sqlite3 ~/.openclaw/memos-plugin/data/memos.db "
SELECT (SELECT COUNT(*) FROM skills WHERE eta >= 0.5) AS skills_recallable,
       (SELECT COUNT(*) FROM world_model WHERE confidence >= 0.2 AND vec IS NOT NULL) AS wms_recallable,
       (SELECT COUNT(*) FROM traces WHERE value > 0.5) AS traces_high_v;"
# 期望：>= 1 / >= 1 / 多条
```

### 5.2 收官 query（精心打中三层关键词）

设计原则：

- 「task-cli **项目现有的目录结构和命名约定**、**环境约束**」 → 命中 **Tier 3 World Model**（标题 / body 关键词）
- 「`python3 -m py_compile` **验证 Python 语法正确性**」 → 命中 **Tier 1 Skill**（`validate_python_syntax_compile`）
- 「**JSONStore / YAMLStore / SQLiteStore**」「**pytest** 测试 + **round-trip**」 → 命中 **Tier 2 Trace**

```bash
openclaw agent --session-id task-cli-demo-recall-show --timeout 150 --json --message \
'我要在 ~/.openclaw/workspace/task-cli/ 这个 Python 项目里加一个新的 Parquet 格式存储后端。请按以下顺序帮我：(1) 根据这个项目现有的目录结构、命名约定和环境约束，告诉我 Parquet 实现文件应该放在哪、文件名叫什么，以及对应测试文件放在哪；(2) 给出 ParquetStore 的实现代码，接口要和现有 JSONStore / YAMLStore / SQLiteStore 完全一致；(3) 写完后立刻用 python3 -m py_compile 验证 Python 语法正确性；(4) 用 pytest 写测试，覆盖正常 round-trip + 路径不存在两种情况。'
```

> Ctrl+C，等 12 秒（这一轮我们只关心召回结果，所以不必等订阅者全部收尾）。

### 5.3 召回查证 — 看注入 prompt 的实际内容

#### 5.3.1 数据库查 `memory_search.candidates`（最直接）

```bash
sqlite3 ~/.openclaw/memos-plugin/data/memos.db \
  "SELECT output_json FROM api_logs WHERE tool_name='memory_search' ORDER BY called_at DESC LIMIT 1;" \
| python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
def show(name, items):
  print(f'\n--- {name} ({len(items)} hits) ---')
  for i, c in enumerate(items, 1):
    tier = str(c.get('tier', '?'))
    kind = str(c.get('refKind', '?'))
    rid  = str(c.get('refId', '?'))
    score = c.get('score', 0)
    snip = (c.get('snippet') or '').split(chr(10))[0][:140]
    print(f'  [{i}] tier={tier:7s} kind={kind:11s} score={score:.3f}  id={rid}')
    print(f'      {snip}')
show('initial candidates (BEFORE LLM filter)', data.get('candidates', []))
show('FINAL filtered (INJECTED INTO PROMPT)', data.get('filtered', []))
show('dropped by LLM filter', data.get('droppedByLlm', []))
"
```

**期望输出**：4 条 candidates，至少包含 1 个 `tier=1 kind=skill` + ≥ 1 个 `tier=2 kind=trace` + 1 个 `tier=3 kind=world-model`，全部出现在 `FINAL filtered` 段（说明都被 LLM filter 保留并注入了 prompt）。

#### 5.3.2 直接抽出注入到 LLM 的 `<memos_context>` 块

agent 的 `--json` 输出里包含完整的 `finalPromptText`。下面这个脚本把 `<memos_context>...</memos_context>` 块解码出来——这就是 OpenClaw 真正喂给底层 LLM 的"插件注入内容"：

```bash
# 需要保留前一轮 agent 命令的完整 stdout（建议每轮都重定向到日志文件）
LOG=/tmp/openclaw-recall-show.log
openclaw agent --session-id task-cli-demo-recall-show --timeout 150 --json --message \
'<同 5.2 query>' > "$LOG" 2>&1

python3 -c "
import re
with open('$LOG', encoding='utf8', errors='ignore') as f:
    text = f.read()
m = re.search(r'<memos_context>([\s\S]*?)</memos_context>', text)
if not m:
    print('NOT FOUND'); raise SystemExit(1)
body = m.group(0).replace(r'\\n', chr(10)).replace(r'\\\"', '\"')
print(body)
"
```

**期望看到三个一级 H2 标题分组**：

```
<memos_context>
# User's conversation history (from memory system)

IMPORTANT: The following are facts from previous conversations with this user.
You MUST treat these as established knowledge and use them directly when answering.

## Candidate skills (call `skill_get` to load any you decide to use)

1. validate_python_syntax_compile
   validate_python_syntax_compile — η=0.50, status=candidate
   验证Python文件语法正确性
   → call `skill_get(id="sk_xxxxxxx")` to load the full procedure if you decide to use it

## Memories

1. Trace · 2026-04-23 09:57
   [assistant] 已在 `~/.openclaw/workspace/task-cli/` 创建并写入测试文件：
   ...

2. Trace · 2026-04-23 09:53
   [assistant] 已在项目中创建并写入：
   - `task-cli/task_cli/storage/yaml_store.py`：新增 `YAMLStore`...

## Environment Knowledge

1. Python task-cli 项目环境认知
   该 Python 命令行项目沿用一致的目录与命名约定：所有持久化层在 task_cli/storage/ 下、
   按格式命名 <fmt>_store.py（json_store.py / yaml_store.py / sqlite_store.py / csv_store.py），
   各自实现统一的 load(path)/save(path, tasks) 接口；CLI 子命令在 task_cli/commands/ 下，...

Available follow-up tools:
- `skill_get(id)` — ...
- `memory_search(query, maxResults?)` — ...
</memos_context>
```

#### 5.3.3 面板「日志」tab 看（适合演示时秀给观众）

打开 `http://127.0.0.1:18799` → 「日志」tab → 找最新的 `memory_search` 卡片展开，能看到：

- **「初步召回」段** — Tier 1 / Tier 2 / Tier 3 三种 candidate 都列出来
- **「Hub 远端」段** — 演示场景下应该是空
- **「LLM 筛选后」段** — 实际注入 prompt 的最终 4 条

#### 5.3.4 OpenClaw WebUI 看完整 prompt（最直观）

如果你的 OpenClaw 里 chat history 可视化是开启的，打开 `http://127.0.0.1:18789/...`（gateway 端口）找到 `task-cli-demo-recall-show` session 的最近一轮 → 点 system / user prompt 详情 → 能看到完整的 `<memos_context>` 块和后面的用户 query。

### 5.4 验收：assistant 的回复要体现三层先验

assistant 的回答应该明显使用了召回的内容：

- **来自 L3 World Model**：直接说"放在 `task_cli/storage/parquet_store.py`、测试放在 `tests/test_parquet_store.py`"——这个命名约定不在 query 里，是从环境认知里读出来的
- **来自 Tier 1 Skill**：写完代码后立刻调用 `python3 -m py_compile` 做语法验证（skill 的 invocation guide）
- **来自 Tier 2 Trace**：`ParquetStore` 类的接口签名 `load(path) / save(path, tasks)` 跟 JSONStore / YAMLStore 完全一致，异常类型一致——这些都是从历史 trace 里学的

> ✅ **演示完美闭环**：项目里**自己亲手通过 OpenClaw 写出来的代码 / 测试 / 项目结构**，被本地插件**沉淀进 L1 / L2 / L3 / Skill 四层**，又在收官轮通过三层检索**完整召回回来**——这就是"Reflect2Evolve V7 在真实编程项目里的核心命题"。

---

## 6. 演示要点速查

### 6.1 沉淀（生成）

| V7 概念 | 第几轮出现 | 在面板哪里看 |
|---|---|---|
| L1 trace | Round 1 起 | **记忆** tab，V/α 数值 |
| Episode | Round 1 起 | **任务** tab |
| **R_task 反思加权 V 回填** | **Round 2 起**（R1 episode 在 R2 时被关闭并评分） | 任务 r_task ≠ null、记忆 V ≠ 0 |
| L2 经验 #1（storage 模式） | Round 2-3 | **经验** tab |
| L2 经验 #2（pytest 模式） | Round 5 | **经验** tab 第 2 条 |
| **Skill 首次结晶** | Round 5 | **技能** tab，candidate |
| L2 经验 #3（CLI command 模式） | Round 8 | **经验** tab 第 3 条 |
| **L3 环境认知** | Round 6+ 自动；或 §9.3 手工 seed | **环境认知** tab |

### 6.2 召回（注入回本项目）

| V7 概念 | 第几轮出现 | 在面板哪里看 |
|---|---|---|
| 冷启动空召回 | Round 1 | 日志 → `memory_search` candidates=[] |
| **Tier 2 记忆召回** | Round 3 起 | 日志 → 初步召回出现 trace |
| **Tier 1 技能召回** | Round 6 起 | 日志 → 初步召回首条是 Skill |
| **三层同时召回** | **收官轮 R10** | 日志 → 同时出现 Skill + Trace + WorldModel |

### 6.3 项目最终状态

跑完所有轮后 `~/.openclaw/workspace/task-cli/` 应该是这样：

```
task-cli/
├── task_cli/
│   ├── __init__.py
│   ├── main.py                # Round 7
│   ├── core/
│   │   └── models.py          # Round 1
│   ├── storage/
│   │   ├── json_store.py      # Round 1
│   │   ├── yaml_store.py      # Round 2
│   │   ├── sqlite_store.py    # Round 3
│   │   └── parquet_store.py   # Round 10 ← 召回三层后产出
│   └── commands/
│       ├── add.py             # Round 7
│       └── list.py            # Round 8
└── tests/
    ├── conftest.py            # Round 4
    ├── test_json_store.py     # Round 4
    ├── test_yaml_store.py     # Round 5
    ├── test_sqlite_store.py   # Round 6
    └── test_parquet_store.py  # Round 10 ← 召回三层后产出
```

最小验证：

```bash
cd ~/.openclaw/workspace/task-cli
python3 -m pip install pyyaml pytest pyarrow
python3 -m pytest -q
# 期望：全绿
```

---

## 7. SQL 二次确认（可选）

```bash
sqlite3 ~/.openclaw/memos-plugin/data/memos.db <<'SQL'
.headers on
.mode column
SELECT 'traces' layer, COUNT(*) n FROM traces
UNION ALL SELECT 'episodes', COUNT(*) FROM episodes
UNION ALL SELECT 'policies (active)', COUNT(*) FROM policies WHERE status='active'
UNION ALL SELECT 'policies (candidate)', COUNT(*) FROM policies WHERE status='candidate'
UNION ALL SELECT 'world_model', COUNT(*) FROM world_model
UNION ALL SELECT 'skills', COUNT(*) FROM skills;

SELECT '--- policies ---' AS info;
SELECT substr(title,1,55) AS title, status, support, round(gain,3) AS gain
FROM policies ORDER BY updated_at DESC;

SELECT '--- world_model ---' AS info;
SELECT substr(title,1,60) AS title, round(confidence,2) AS conf,
       induced_by, length(vec) AS vec_bytes
FROM world_model;

SELECT '--- skills ---' AS info;
SELECT substr(name,1,55) AS name, status, version,
       round(eta,3) AS eta, support
FROM skills ORDER BY updated_at DESC;

SELECT '--- recent api_logs ---' AS info;
SELECT tool_name, COUNT(*) AS n, SUM(success) AS ok
FROM api_logs GROUP BY tool_name ORDER BY tool_name;
SQL
```

---

## 8. 一段话总结

> 我们用 9 + 1 轮 `openclaw agent` 对话，让 OpenClaw 在 `~/.openclaw/workspace/task-cli/` 目录里**从零增量构建**了一个真实可运行的 Python 任务管理 CLI——三种 storage 后端 + 三组 pytest 测试 + 两个 CLI 子命令 + 一个 Parquet 扩展。
>
> **沉淀层面**：项目里每一行代码、每一组测试、每一个目录结构，都被本地插件沉淀成一连串 L1 记忆 / 多条 L2 经验 / 1 条 L3 环境认知 / 1 条 Skill。
>
> **召回层面**：Round 3 看到 Tier 2 记忆召回首次发生（之前写的 storage 代码注入到下一个 storage 任务），Round 6 看到 Tier 1 技能首次接管（结晶出来的 pytest 模板直接生成新测试），**收官轮看到三层同时命中**——pytest 技能 + storage 记忆 + 项目环境认知**全部回流注入**，由 OpenClaw 一步到位写出风格完全一致的 Parquet 实现 + 测试。
>
> 这正是 Reflect2Evolve V7 在真实编程项目里的核心命题：
> **智能体在你的项目里"先做"，插件把"做"的过程加工成"证据 → 策略 → 结构 → 能力"，下一次再做相似的事时，这些能力被精准召回——同一个项目的产出，反过来让同一个项目的下一次开发越来越快、越来越统一**。
