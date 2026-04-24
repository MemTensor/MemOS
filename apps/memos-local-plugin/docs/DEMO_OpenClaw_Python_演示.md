# Reflect2Evolve V7 — OpenClaw 演示剧本

> 用一个 Python 小项目（**配置文件读取工具 + 对应单元测试**）演示 V7 算法的完整沉淀链路：
> **L1 记忆 → L2 经验归纳 → L3 环境认知 → Skill 结晶 / 升级**。
>
> 全程使用 `openclaw agent` 命令行 + 浏览器打开 `http://127.0.0.1:18799`。
> 共 6 轮交互，每轮 1 条消息，全程约 15 分钟。
>
> **已实测验证**：以下所有数据来自 2026-04-20 实际运行结果。

---

## 0. 演示前准备

### 0.1 确认环境

```bash
openclaw plugins list | grep memos-local-plugin
# 期望：memos-local-plugin (loaded)

open http://127.0.0.1:18799
```

### 0.2 配真实模型（必须）

进入 **设置 → AI 模型**，确保三个卡片都配了**真实可用的 LLM Key** 并且「测试」按钮显示 *Connection OK*。

| 卡片 | 推荐 | 不配的后果 |
|------|------|------------|
| 嵌入模型 | bge-m3 / text-embedding-3-large | 语义检索失效，L2 归纳变弱 |
| 摘要模型（必填） | gpt-4o-mini / claude-haiku 等**非思考型** | **不会生成任何经验和技能** |
| 技能结晶模型 | gpt-5-thinking / claude-sonnet 等**思考型** | 留空沿用摘要模型，技能质量下降但能跑 |

### 0.3 清空旧数据

```bash
sqlite3 ~/.openclaw/memos-plugin/data/memos.db <<'SQL'
DELETE FROM traces;
DELETE FROM episodes;
DELETE FROM policies;
DELETE FROM world_model;
DELETE FROM skills;
DELETE FROM api_logs;
DELETE FROM feedback;
DELETE FROM decision_repairs;
DELETE FROM l2_candidate_pool;
DELETE FROM sessions;
SQL

openclaw gateway restart
sleep 5
```

刷新面板，五个总览数字应该都是 0。

### 0.4 关键注意事项

- **每轮只发 1 条消息**，不要发第二条「谢谢/OK」之类的确认。`openclaw agent` 每次调用是独立连接，第二条消息会被 relation classifier 判为 follow_up 并开新 episode，导致产生一个内容空洞的任务，LLM 评分器会给负分。
- **命令返回后需要手动 Ctrl+C**：`openclaw agent` 在 JSON 输出完成后不会自动退出（会进入 hub retry 循环）。看到 `"stopReason": "stop"` 或 `[plugins] memos-local: plugin ready` 就可以 Ctrl+C 了。
- **每轮 Ctrl+C 之后等 40–50 秒**再去面板看，让 capture / reward / L2 / L3 / skill 订阅者跑完。
- **召回（检索）在日志页看**：每轮的 `memory_search` 日志卡片展开后有三段 — 「初步召回」（embedder 候选）→「Hub 远端」→「LLM 筛选后」。被注入给 assistant 的记忆/技能/经验就在「LLM 筛选后」里。

---

## Round 1 · 写 JSON 读取函数（L1 起点）

```bash
openclaw agent --session-id demo-r1 \
  --message "帮我用 Python 写一个函数 load_json_config(path: str) -> dict，读取 JSON 配置文件并返回字典。要求：带 docstring 和类型注解；path 不存在时抛 FileNotFoundError 并附中文提示；JSON 解析失败时抛带行号的友好错误；强制 UTF-8 编码。跑通了就行，不用额外解释。" \
  --timeout 120 --json
```

> 命令返回后 Ctrl+C，等 40 秒。

### 面板检查

| 面板 tab | 期待看到 |
|---|---|
| **总览** | 记忆=1，任务=1 |
| **记忆** | 1 条记忆，V ≈ 0.75，α = 0.9 |
| **任务** | 1 个「已完成」任务，R_task ≈ 0.75 |
| **经验** | 0 — 需要跨任务相似才触发 L2 归纳 |
| **环境认知 / 技能** | 0 |
| **日志** | `memory_search` 卡片展开 → **「初步召回」段落是空的**（`candidates: []`）—— 冷启动，系统还没有任何历史记忆 |
| **日志** | `memory_add` + `task_done` |

> 这一步演示了 **L1 trace 写入 + 反思加权 V 回填**。注意 memory_search 是空召回 — 这是对照基线，后续轮次会逐渐出现更多召回内容。

---

## Round 2 · 写 YAML 读取函数（触发跨任务 L2 归纳）

```bash
openclaw agent --session-id demo-r2 \
  --message "帮我用 Python 写一个函数 load_yaml_config(path: str) -> dict，用 PyYAML 读取 YAML 配置文件并返回字典。要求：带 docstring 和类型注解；path 不存在时抛 FileNotFoundError 并附中文提示；YAML 解析失败时抛友好错误；强制 UTF-8 编码。直接给代码就行。" \
  --timeout 120 --json
```

> Ctrl+C，等 40 秒。

### 面板检查

| 面板 tab | 期待看到 |
|---|---|
| **总览** | 记忆=2，任务=2，**经验=1**（0 → 1） |
| **经验** | 新增 1 条，标题类似「Load config file with UTF-8 and friendly errors」，**status=已启用，support=2，gain ≈ 0.44**；点开可看到完整的 trigger / procedure / verification / boundary |
| **日志** | 新增 `policy_generate` 事件 |

> 这一步验证了 **跨任务 L2 归纳** — 两个不同任务（JSON vs YAML）的子问题（读配置+异常处理+UTF-8）被自动识别并归纳成一条可复用经验。

---

## Round 3 · 写 TOML 读取函数（经验关联强化）

```bash
openclaw agent --session-id demo-r3 \
  --message "再帮我写一个函数 load_toml_config(path: str) -> dict，用 Python 3.11+ 标准库 tomllib 读取 TOML 配置文件并返回字典。要求：带 docstring 和类型注解；path 不存在时抛 FileNotFoundError 并附中文提示；TOML 解析失败时抛友好错误；强制 UTF-8 编码。直接给代码。" \
  --timeout 120 --json
```

> Ctrl+C，等 40 秒。

### 面板检查

| 面板 tab | 期待看到 |
|---|---|
| **经验** | 上一轮那条经验 **support 升到 3**（从 2 → 3）— 新 trace 被关联到已有 policy |
| **技能 / 环境认知** | 仍为 0 — L3 需要至少 2 条不同 policy 才能聚合，当前只有 1 条 |
| **日志 → memory_search** | **这是第一次看到记忆召回！** 展开 `memory_search` 卡片，「初步召回」里有 2 条 Tier 2 trace：<br>① Round 1 的 JSON loader（score ≈ 0.72，高相关）<br>② Round 2 的 YAML loader（score ≈ 0.05，弱相关）<br>「LLM 筛选后」两条都被保留，说明系统把之前写过的代码**注入给了 assistant 作参考** |

> 这一步同时验证了 **L2 关联强化** 和 **Tier 2 记忆召回**。assistant 写 TOML 版时能直接参考之前 JSON/YAML 版的代码 — 这就是「越用越快」的底层机制。

---

## Round 4 · 写 pytest 测试（第二个子问题模式）

> 关键点：切换到**不同类型的子问题**（写测试 vs 写函数），但仍在同一个领域（Python 配置文件）。
> 这将产生**第 2 条 policy**，为 L3 聚合和 Skill 结晶创造条件。

```bash
openclaw agent --session-id demo-r4 \
  --message "帮我用 pytest 给下面这个函数写单元测试：def load_json_config(path: str) -> dict，它读 JSON 配置文件，path 不存在时抛 FileNotFoundError，JSON 解析失败时抛 ValueError。要求：覆盖正常读取、文件不存在、JSON 格式错误三种情况，用 tmp_path fixture 创建临时文件。直接给测试代码。" \
  --timeout 120 --json
```

> Ctrl+C，等 40 秒。

### 面板检查

| 面板 tab | 期待看到 |
|---|---|
| **总览** | 记忆=4，任务=4 |
| **经验** | 仍为 1 — 第 2 条 policy 还需要第二个相似任务才能归纳 |
| **日志** | `memory_search` 卡片展开 → **「初步召回」里没有记忆命中**（pytest 和配置读取的 embedding 距离较远），说明检索是领域敏感的 |

> 这一步为下一轮的 L2 归纳做准备。单独一个 pytest 任务还不够触发第 2 条经验。

---

## Round 5 · 再写一个 pytest 测试（触发第 2 条经验 + Skill 首次结晶）

```bash
openclaw agent --session-id demo-r5 \
  --message "帮我用 pytest 给这个函数写单元测试：def load_yaml_config(path: str) -> dict，它用 PyYAML 读 YAML 配置文件，path 不存在时抛 FileNotFoundError，YAML 解析失败时抛 ValueError。要求：覆盖正常读取、文件不存在、YAML 格式错误三种情况，用 tmp_path fixture。直接给测试代码。" \
  --timeout 120 --json
```

> Ctrl+C，等 50 秒（这一轮 pipeline 处理较多，需要更长时间）。

### 面板检查

| 面板 tab | 期待看到 |
|---|---|
| **总览** | 记忆=5，任务=5，**经验=2**（1→2），**技能=1**（0→1） |
| **经验** | 新增第 2 条「Write pytest unit tests for config file loaders」，**status=已启用，support=2，gain ≈ 0.75** |
| **技能** | 新增 1 条「pytest_config_loader_tests」，**status=候选（probationary）**，v1，η ≈ 0.875，support=2 |
| **技能 → 进化时间线** | 「开始结晶」→「结晶完成」 |
| **日志** | `policy_generate` + `skill_generate` 事件 |

> **这是演示的第一个高潮** — 两种不同的经验同时存在（写函数 + 写测试），并且 pytest 经验直接结晶出了第一条可调用技能。

---

## Round 6 · 第三个 pytest 测试（触发 L3 环境认知 + Skill 升级）

```bash
openclaw agent --session-id demo-r6 \
  --message "帮我用 pytest 给这个函数写单元测试：def load_toml_config(path: str) -> dict，它用 tomllib 读 TOML 配置文件，path 不存在时抛 FileNotFoundError，TOML 解析失败时抛 tomllib.TOMLDecodeError。要求：覆盖正常读取、文件不存在、格式错误，用 tmp_path fixture。直接给测试代码。" \
  --timeout 120 --json
```

> Ctrl+C，等 50 秒。

### 面板检查

| 面板 tab | 期待看到 |
|---|---|
| **总览** | 记忆=6，任务=6，经验=2，**环境认知=1**（0→1），技能=1 |
| **经验** | pytest 经验 **support 升到 3** |
| **环境认知** | **新增 1 条**「Python config file loading and testing environment」— 这是 L3 首次生成！点开能看到系统对「Python 配置文件读写 + 测试」这个环境的压缩认知 |
| **技能** | 名称变为「pytest_config_loader_tests_v2」，**version=2**（重建过一次），η ≈ 0.75，support=3 |
| **技能 → 进化时间线** | 多出「重建」事件 |
| **日志 → memory_search** | **Tier 1 技能召回！** 展开 `memory_search` 卡片，「初步召回」里第一条是：<br>`Skill: pytest_config_loader_tests (η=0.88)` score ≈ 0.76<br>这说明系统**用已结晶的技能直接接管了这轮任务**，而不是从零摸索。技能的 invocation guide（包含「三个测试用例 + tmp_path + 覆盖正常/缺失/格式错误」模板）被完整注入到 assistant prompt 中 |
| **日志** | `world_model_generate` + `skill_evolve` 事件 |

> **这是演示的最终高潮** — 你在面板里同时看到：
>
> 1. **四层数据全部有值**：记忆（6）→ 经验（2）→ 环境认知（1）→ 技能（1，v2）
> 2. **三层检索全部可见**：Round 1 空召回（冷启动）→ Round 3 Tier 2 trace 召回 → Round 6 **Tier 1 技能召回**
>
> 这正是算法文档描述的层级演化系统：
> `raw interaction → M¹ → M² → M³ → S → 下一次交互检索注入`

---

## Round 7 · 加入新格式支持（同时触发三层召回：记忆 + 技能 + 环境认知）

> **这是演示的收官之作**。我们让 agent 为项目加入 INI 格式支持。这条 query 同时覆盖了：
> - 「项目目录结构 / 环境约束」→ 命中 **Tier 3 环境认知**
> - 「pytest 写测试」→ 命中 **Tier 1 技能**
> - 与之前写过的配置读取代码相似 → 命中 **Tier 2 记忆**
>
> 三层检索全部触发，注入 prompt 的内容按 `# Skills` / `# Memories` / `# Environment Knowledge` 三个一级标题分组呈现。

```bash
openclaw agent --session-id demo-final-3tier \
  --message "我要在这个 Python 配置文件项目里加一个新的 INI 格式支持。请根据现有的项目目录结构、测试组织方式和环境约束，告诉我应该把代码放在哪里、测试怎么写、有什么需要注意的限制条件。然后用 pytest 写出测试代码。" \
  --timeout 120 --json
```

> Ctrl+C，等 35 秒。

### 面板检查

| 面板 tab | 期待看到 |
|---|---|
| **日志 → memory_search** | **三层全部召回：**<br>① **Tier 2 记忆**：之前写过的配置读取代码（score ≈ 0.75）<br>② **Tier 1 技能**：`pytest_config_loader_tests (η=0.75)` score ≈ 0.64<br>③ **Tier 3 环境认知**：`Python config file loading and testing environment` score ≈ 0.37<br>三条都在「LLM 筛选后」保留，**全部注入给了 assistant** |
| **OpenClaw WebUI → 该 session** | 在 `<memos_context>` 块里能看到三个一级标题分组：<br>• `# Skills` — pytest 技能的完整 invocation guide<br>• `# Memories` — 之前写过的配置代码<br>• `# Environment Knowledge` — 项目结构 + 推理规则 + 约束 |
| **assistant 回复** | 回复中应该体现出：<br>• 对项目目录结构的了解（来自 L3 环境认知）<br>• 按技能模板组织的三个 pytest 测试用例（来自 Skill）<br>• 与之前 JSON/YAML/TOML 版本一致的代码风格（来自 Trace） |

> **关于经验（L2 policy）为什么没出现在召回候选里**：
>
> 这是 V7 的设计决策（算法文档 2.6 节）。被检索系统直接召回注入 prompt 的只有三种：
>
> | 检索层 | 召回对象 | 注入标题 |
> |---|---|---|
> | Tier 1 | **技能 (Skill)** | `# Skills` |
> | Tier 2 | **记忆 (Trace)** | `# Memories` |
> | Tier 3 | **环境认知 (World Model)** | `# Environment Knowledge` |
>
> 经验（L2 policy）**不直接召回**，而是通过两个间接路径参与：
> 1. 经验结晶成 Skill 后，由 Tier 1 整体注入（Skill 包含了经验的 trigger / procedure / verification / boundary）
> 2. 经验的 preference / anti-pattern 附在 Skill 的 `decision_guidance` 字段里一起注入
>
> **经验是 Skill 的原料，不是独立的检索候选。**

---

## 演示要点速查

### 沉淀（写入 / 生成）

| V7 概念 | 第几轮出现 | 在面板哪里看 |
|---|---|---|
| L1 trace（步级记忆） | Round 1 | **记忆** tab，V/α 数值 |
| Episode（任务） | Round 1 | **任务** tab |
| R_task 反思加权 V 回填 | Round 1 | 任意 trace 的 V ≠ 0 |
| 跨任务 L2 归纳（第 1 条经验） | Round 2 | **经验** tab，support=2 |
| L2 关联强化（support 递增） | Round 3 | 经验 support 2→3 |
| 第 2 条经验（不同子问题模式） | Round 5 | **经验** tab 2 条 |
| Skill 首次结晶 | Round 5 | **技能** tab，probationary |
| L3 环境认知 | Round 6 | **环境认知** tab，1 条 |
| Skill 升级（v1→v2） | Round 6 | 技能 version=2，进化时间线 +1 行 |

### 召回（检索 / 注入）

| V7 概念 | 第几轮出现 | 在面板哪里看 |
|---|---|---|
| 冷启动空召回 | Round 1 | **日志** → `memory_search` → 初步召回 `candidates: []` |
| **Tier 2 记忆召回** | Round 3 | **日志** → `memory_search` → 初步召回有 2 条 trace（JSON loader score=0.72, YAML loader score=0.05），LLM 筛选后保留并注入 prompt |
| **Tier 1 技能召回** | Round 6 | **日志** → `memory_search` → 初步召回第一条是 `Skill: pytest_config_loader_tests (η=0.88)` score=0.76，完整 invocation guide 被注入 prompt |
| **三层同时召回** | Round 7 | **日志** → `memory_search` → 同时出现记忆 (score=0.75) + 技能 (score=0.64) + 环境认知 (score=0.37)，全部通过 LLM 筛选。OpenClaw WebUI 里注入 prompt 按 `# Skills` / `# Memories` / `# Environment Knowledge` 三个标题分组 |

> **经验（L2 policy）不直接召回**。经验通过结晶成 Skill 后由 Tier 1 整体注入。面板「经验」tab 里看到的内容，agent 是通过「技能」这个载体拿到的。

---

## 验证 — SQL 二次确认（可选）

```bash
sqlite3 ~/.openclaw/memos-plugin/data/memos.db <<'SQL'
.headers on
.mode column
SELECT 'traces' layer, COUNT(*) n FROM traces
UNION ALL SELECT 'episodes', COUNT(*) FROM episodes
UNION ALL SELECT 'policies', COUNT(*) FROM policies
UNION ALL SELECT 'world_model', COUNT(*) FROM world_model
UNION ALL SELECT 'skills', COUNT(*) FROM skills;

SELECT '--- policies ---' AS info;
SELECT substr(title,1,55) AS title, status, support, round(gain,3) AS gain
FROM policies ORDER BY updated_at DESC;

SELECT '--- world_model ---' AS info;
SELECT substr(title,1,60) AS title FROM world_model;

SELECT '--- skills ---' AS info;
SELECT substr(name,1,55) AS name, status, version,
       round(eta,3) AS eta, support
FROM skills ORDER BY updated_at DESC;
SQL
```

期望：

```
traces       6
episodes     6
policies     2
world_model  1
skills       1
```

---

## 一段话总结

> 我们用 7 轮对话让 OpenClaw 写了 3 个 Python 配置读取函数 + 3 组 pytest 测试，最后一轮要求为项目加入 INI 格式支持。
>
> **沉淀链路：**
> - **Round 1**：L1 记忆写入，冷启动空召回。
> - **Round 2**：跨任务 L2 经验归纳 — 「读配置 + 异常处理 + UTF-8」被自动识别为可复用策略。
> - **Round 3**：L2 关联强化 + **Tier 2 记忆召回**（之前写的 JSON/YAML 代码被注入给 assistant 作参考）。
> - **Round 4–5**：切换到 pytest 模式，第 2 条经验被归纳，**Skill 首次结晶**。
> - **Round 6**：**L3 环境认知生成** + **Skill 升级 v2** + **Tier 1 技能召回**。
> - **Round 7**：**三层检索同时命中** — 记忆 (score=0.75) + 技能 (score=0.64) + 环境认知 (score=0.37) 全部注入 prompt，按 `# Skills` / `# Memories` / `# Environment Knowledge` 三个标题分组呈现。
>
> **最终面板上同时看到：**
> - 四层沉淀数据：记忆 → 经验 → 环境认知 → 技能（v2）
> - 三层检索全覆盖：空召回 → Tier 2 记忆召回 → Tier 1 技能召回 → **三层同时召回**
>
> 这正是 Reflect2Evolve V7 的核心命题：
> **智能体不是「记得更多」就更聪明，而是把交互经验逐层加工成「证据 → 策略 → 结构 → 能力」，然后在后续交互中通过三层检索把这些能力注入回来 — 越用越好用。**
