# 前端验收流程

本文档有两部分：

1. **一键自动化脚本**（`scripts/e2e-probe.sh`）——通过 REST 给面板喂一个 Python 编程任务的完整多轮对话，跑完之后对比各层数据的增量，告诉你记忆 / 任务 / 经验 / 环境认知 / 技能是否都有新增。
2. **手动前端验收清单**——你自己在 OpenClaw 里聊几轮对话，然后一个 tab 一个 tab 对着表勾。

---

## 一、一键自动化脚本

### 依赖

安装 `curl` 和 `jq`（macOS：`brew install jq`，Linux：`apt-get install jq`）。

### 运行

```bash
# 如果是首次打开面板，带上要设置的密码：
bash apps/memos-local-plugin/scripts/e2e-probe.sh \
     --url http://127.0.0.1:18799 \
     --password test1234

# 已经设过密码，后续只需登录：
bash apps/memos-local-plugin/scripts/e2e-probe.sh --password test1234

# 没开密码保护：
bash apps/memos-local-plugin/scripts/e2e-probe.sh
```

### 输出解读

```
▸ Probing viewer at http://127.0.0.1:18799
✓ Viewer alive (agent=openclaw)
...
▸ Baseline: {"traces":0,"episodes":0,"apiLogs":0,"policies":0,"worldModels":0,"skills":0,...}
▸ Turn 1 — intent: write a function
▸ Turn 2 — follow-up: add error handling
▸ Turn 3 — user confirms it works
▸ Turn 4 — similar task (should trigger experience → policy reuse)
▸ Turn 5 — user gives negative feedback → should surface as takeaway
✓ 5 synthetic turns submitted
▸ Waiting 12s for reward backprop + L2 induction + skill crystallisation…

============================================================
 V7 layer delta (baseline → after)
============================================================
  traces             0  →  5       Δ+5
  episodes           0  →  1       Δ+1
  apiLogs            0  →  10      Δ+10
  policies           0  →  1       Δ+1   ← 经验生成成功
  worldModels        0  →  0       Δ+0   ← 需要更多相似任务才结晶
  skills             0  →  1       Δ+1   ← 技能结晶成功
============================================================
```

- `traces Δ+5`：5 轮对话都被记忆（必现）
- `episodes Δ+1`：5 轮对话被归纳为 1 个任务（必现；若 LLM 判定为新任务会有多个）
- `apiLogs Δ+10`：5×(memory_search + memory_add) = 10 条 API 日志
- `policies Δ+1`：**经验生成** — 需要 Summarizer 和 Skill-Evolver 都配了真实 LLM Key 才会出
- `worldModels Δ`：**环境认知** — 需要至少 2 条结构相似的经验才结晶；单次 probe 通常不够
- `skills Δ+1`：**技能** — 经验被验证后才生成

如果 `policies / skills` 都是 0，去 Settings → AI 模型，配真实的 OpenAI / Anthropic / Gemini Key，点每个卡片的"测试"按钮确认连通，再回来跑一次脚本。

---

## 二、手动前端验收清单

打开 `http://127.0.0.1:18799/`，首次会弹设置密码页面（图标是 openclaw 吉祥物或 hermes logo），填完密码进入。

在另一个终端启动 `openclaw chat`，照下面的**五轮**聊下来。每轮之后切回面板看对应 tab 是否按"期待"变化。

### 第一轮 —— 建立事实

```
我喜欢吃榴莲。
记住：我早上只喝豆浆，不喝咖啡。
```

| 面板 tab      | 期待看到                                                                 |
|--------------|--------------------------------------------------------------------------|
| 记忆          | 多出 2 条，每条显示 summary、私有 pill、时间戳、V/α 数值                   |
| 日志 (`memory_add`) | 卡片**默认展开**，行内直接显示新加入的记忆内容（不用点击）              |
| 日志 (`memory_search`) | 展开后三段：初步召回 / Hub 远端 / LLM 筛选后，候选带分数和 role pill |

### 第二轮 —— 检索 + 任务归纳

```
我明天早餐吃什么好？
```

| 面板 tab | 期待看到 |
|---------|---------|
| 日志 (`memory_search`) | 新条目，"LLM 筛选后"段落命中上一轮"喝豆浆"的记忆 |
| OpenClaw 回复 | 反映出"你早上喝豆浆，不喝咖啡" → 说明召回注入到 prompt 了 |
| 任务 | 出现一条任务卡；多轮后状态会变成"已完成"；点卡片右侧抽屉是**聊天视图**（左 assistant 气泡 / 右 user 气泡） |

### 第三轮 —— Python 编程任务（自动化脚本里的同款）

这轮用来验证 **任务 → 经验 → 技能** 的结晶链。

```
帮我写一个 Python 函数，读 CSV 并返回每列的平均值。
如果文件不存在或者列不是数字怎么办？
跑通了，谢谢。
```

| 面板 tab | 期待看到 |
|---------|---------|
| 任务 | "Python CSV 平均值函数"这类标题的任务卡，状态"已完成"，旁边有 "Skill generated" 状态条 |
| 经验 | 出现"用户请求 Python 数据处理时，优先 pandas + try/except"类经验条目 |
| 技能 | 出现"读表并聚合"类技能；η (采纳率) 先从 probationary → active |
| 日志 (`task_summarize`) | 任务完成事件 |
| 日志 (`skill_generate`) | 技能生成事件 |

### 第四轮 —— 相似任务验证经验可复用

```
再帮我写一个类似的，读 JSON 并返回每字段的非空占比。
```

| 面板 tab | 期待看到 |
|---------|---------|
| 日志 (`memory_search`) | 第三轮那条经验被检索出来放进 prompt |
| 经验 | 原经验的 `support` / `gain` 数值增加 |
| 技能 | 原技能的 η 提升 |

### 第五轮 —— 用户反馈转成经验

```
不要用 pandas，我只想用标准库。
```

反馈类发言触发 Feedback → Policy 链路。

| 面板 tab | 期待看到 |
|---------|---------|
| 经验 | 新增"不用 pandas，优先标准库"类经验（`trigger` 是用户偏好，`procedure` 是具体做法） |
| 日志 (`feedback_submit`) | 反馈事件 |
| 日志 (`policy_generate`) | 新经验结晶事件 |

### 任务跳过的反面测试

故意发一条很短的：

```
hi
```

然后 Ctrl+C 结束 `openclaw chat`。

| 面板 tab | 期待看到 |
|---------|---------|
| 任务 | 出现"已跳过"状态卡；右侧中文原因摘自旧版插件：`对话轮次不足，需要至少 2 轮完整的问答交互才能生成摘要。` |

---

## 三、"为什么没出来"的排错

| 现象 | 可能原因 / 修法 |
|------|---------------|
| 记忆没出现 | 日志 → `memory_add` 没有任何条目 → OpenClaw 没调用插件 hook。检查 `~/.openclaw/openclaw.json` 里 `memtensor-memos-local-plugin` 是否 enabled。 |
| 经验 / 技能一直 0 | Summarizer / Skill-Evolver 用的是本地 fallback，没接真实 LLM。Settings → AI 模型，每个卡片配好，点"测试"看到 "Connection OK"，再触发对话。 |
| 任务一直"已跳过" | 对话太短 (`chunks < 4` 或 `min(user, assistant) < 2`)。多聊几轮或同主题连续追问。 |
| 环境认知一直 0 | 需要至少 2 条**结构相似**的经验才结晶。单次 probe 通常不够，持续用两三天就会出现。 |
| 登录密码忘了 | `rm ~/.openclaw/memos-plugin/.auth.json` 删掉就重置，下次进入是首次设置密码页。 |

---

## 四、V7 算法测试的关系

| 层级 | 本文档在哪里验证 | 也可以用 `npm test` 验证哪个测试 |
|------|-----------------|-------------------------------|
| L1 traces | 记忆 tab / `memory_add` 日志 | `tests/unit/capture/*` + `tests/unit/adapters/openclaw-e2e.test.ts` |
| Tasks (episodes) | 任务 tab | `tests/unit/session/*` + `tests/unit/reward/task-summary.test.ts` |
| L2 policies | 经验 tab | `tests/unit/memory/l2/*` + `l2.integration.test.ts` |
| Skills | 技能 tab | `tests/unit/skill/*` + `skill.integration.test.ts` |
| L3 environment | 环境认知 tab | `tests/unit/memory/l3/*` + `l3.integration.test.ts` |
| Feedback → Policy | 用户反馈转经验 | `tests/unit/feedback/*` + `feedback.integration.test.ts` |
| Retrieval | `memory_search` 日志三段 | `tests/unit/retrieval/*` |
| Reward | 任务 V/α 数值 | `tests/unit/reward/*` + `reward.integration.test.ts` |

跑 `npm test` 全绿（700+ tests）= V7 算法管道在技术层面不破；本文档两部分的**前端可见验收** = 算法确实在你装好的实际环境里生效。
