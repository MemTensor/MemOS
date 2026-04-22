# 手工端到端测试指南

> 目的：在本地快速清空 memos-local-plugin 的记忆库 → 降低算法阈值 →
> 通过 openclaw CLI 模拟多轮对话 → 验证 L1（记忆）/ L2（经验）/
> L3（环境认知）/ Skill（技能）四层是否全部沉淀。
>
> 适用场景：
> - 验证流水线是否贯通
> - 给前端页面准备测试数据
> - 排查"某一层一直是空的"类问题
>
> 对照文档：`apps/memos-local-openclaw/算法设计_Reflect2Skill_V7_核心详解.md`

---

## 0. 准备工作

### 0.1 前置条件

- `openclaw` CLI 已装好，`memos-local-plugin` 已通过 `install.sh` 部署到
  `~/.openclaw/extensions/memos-local-plugin/`。
- 确认 `openclaw plugins list | grep memos-local-plugin` 显示 `loaded`。
- 已配置好 LLM / Embedding 的 apiKey（`~/.openclaw/memos-plugin/config.yaml`
  里的 `llm.apiKey` / `embedding.apiKey`），否则 reward 评分和 policy
  induction 跑不起来。

### 0.2 相关路径

| 用途                | 路径                                                       |
|---------------------|------------------------------------------------------------|
| 用户态配置          | `~/.openclaw/memos-plugin/config.yaml`                     |
| SQLite 数据库       | `~/.openclaw/memos-plugin/data/memos.db`                   |
| 技能包导出目录      | `~/.openclaw/memos-plugin/skills/`                         |
| 日志目录            | `~/.openclaw/memos-plugin/logs/`                           |
| Viewer              | `http://127.0.0.1:18799`                                   |
| 插件源码            | `apps/memos-local-plugin/`                                 |

---

## 1. 清空旧数据

> 脏数据会让新实验的结果被老的 episode/policy 污染，尤其是
> `l2_candidate_pool` 里的 signature bucket 残留。

```bash
# 1) 停掉正在监听 18799 的 openclaw-gateway（viewer 所在进程）
lsof -i :18799 -P | awk '/LISTEN/ {print $2}' | xargs -r kill -9
sleep 2
lsof -i :18799 -P | head   # 应该什么都没有

# 2) 删库（SQLite + WAL + SHM）
rm -f ~/.openclaw/memos-plugin/data/memos.db \
      ~/.openclaw/memos-plugin/data/memos.db-shm \
      ~/.openclaw/memos-plugin/data/memos.db-wal
```

`~/.openclaw/memos-plugin/logs/` 和 `skills/` 按需清理（通常直接留空即可）。

---

## 2. 降低算法阈值

生产默认值（`core/config/defaults.ts`）是给真实长期使用调的；单机几通对话
根本不够触发 L2/L3/Skill。把下面这段追加到
`~/.openclaw/memos-plugin/config.yaml` 的末尾：

```yaml
algorithm:
  l2Induction:
    minTraceValue: 0.01         # default 0.1  — accept near-zero-V traces
    minEpisodesForInduction: 2  # keep
    minSimilarity: 0.72         # keep — 太低会让所有 Python 问题塞进同一个 policy，反而看不到 L3 分簇
  l3Abstraction:
    minPolicies: 2              # default 3
    minPolicySupport: 1
    minPolicyGain: 0.01         # default 0.1
    cooldownDays: 0             # default 1 — 测试期立即重跑
    clusterMinSimilarity: 0.55  # default 0.6
  skill:
    minSupport: 1               # default 3
    minGain: 0.05               # default 0.15
    probationaryTrials: 1       # default 5 — 一次成功使用即转 active
    cooldownMs: 0               # default 6h — 无冷却
```

保存后恢复权限（config 里有 apiKey）：

```bash
chmod 600 ~/.openclaw/memos-plugin/config.yaml
```

> ⚠️ 跑完测试记得把这些字段删掉或调回默认，否则线上会出现"所有痕迹
> 都结晶成 policy / skill"的噪声。

---

## 3. 准备提示词：让同一族 signature 命中多次

### 3.1 L2 signature 规则

`core/memory/l2/signature.ts`：

```
signature = `${primaryTag}|${secondaryTag}|${tool}|${errCode}`
```

- `primaryTag` / `secondaryTag`：trace.tags 按字母序的前两个。
- `tool`：第一个 toolCall.name 的小写首段。
- `errCode`：tool 输出里的大写错误码，没有就是 `_`。

要触发 induction，必须：
- 至少 **2 个不同 episode** 落进同一个 signature bucket
  (`minEpisodesForInduction=2`)
- 每条 trace 的 `value >= minTraceValue`（我们降到 0.01）

所以同族主题要用**相似但不同任务**（例如都写 Python 函数，但一个是平均
值、一个是排序、一个是文件读取），保证 tags 一致但内容各异。

### 3.2 L3 cluster key 规则

`core/memory/l3/cluster.ts::domainKeyOf`：regex 扫 policy 的 title+trigger
+procedure+boundary，取**第一个匹配的 TAG_REGEX**。

TAG_REGEX 顺序（会决定 primary）：
```
docker → alpine → node → python → rust → go → java → db → network → git → k8s → cloud
```

要让多个 policy 聚到同一个 cluster：policy 的 body 要都命中同一个 tag
（例如都只提 Python，不要提 Docker/Node）。

### 3.3 tagger 关键字（`core/capture/tagger.ts`）

以下关键字会自动打标（命中即进 tags，按字母序取前两个作为 L2 signature）：

| 关键字正则                              | 打的 tag       |
|-----------------------------------------|----------------|
| `python`, `.py`                         | `python`       |
| `sql`, `select `, `insert `             | `sql`          |
| `postgres`, `mysql`, `sqlite`, `database` | `database`   |
| `shell`, `bash`, `zsh`, `terminal`      | `shell`        |
| `pytest`, `unit test`, `vitest`, `jest` | `test`         |
| `api`, `rest`, `http`                   | `http`         |
| `auth`, `token`, `oauth`                | `auth`         |
| `error`, `exception`, `traceback`       | `error`        |
| `docker`, `container`                   | `docker`       |
| `git`, `commit`, `branch`               | `git`          |

---

## 4. 执行：用 openclaw CLI 模拟对话

命令模板：

```bash
openclaw agent \
  --session-id <unique-id> \
  --message "<用户消息>" \
  --timeout 90 \
  --json 2>&1 | tail -3
```

- `--session-id` **必须每次不同**，否则会被 `session.relation` 分类成
  `follow_up` 合并进同一 episode。
- `--timeout` 给 90 秒就足够，Python / SQL 这种短问题通常 20–40 秒返回。
- 返回的 JSON 尾部会打印 `"stopReason": "stop"`，代表一个 episode 正常
  结束。
- 命令返回后，capture/reward/L2/L3/skill 订阅者还在后台跑，**至少等 30
  秒**再查库。

### 4.1 触发 L1 记忆（20 通对话 ≈ 20 条 trace）

任意主题都行，只要让它写点东西。

### 4.2 触发 L2 经验（需要同一 signature 至少 2 个 episode）

同一主题跑 3 通对话：

```bash
# 主题 A：写 Python 函数（→ tags=["python"]，signature=python|_|_|_）
openclaw agent --session-id py-1 --message "用 Python 写一个函数，接收一个整数列表，返回它们的平均值。要求带 docstring 和类型注解。" --timeout 90 --json 2>&1 | tail -3
openclaw agent --session-id py-2 --message "用 Python 写一个快速排序函数，要求带 docstring 和类型注解，处理空列表的情况。" --timeout 90 --json 2>&1 | tail -3
openclaw agent --session-id py-3 --message "用 Python 写一个函数读取 CSV 文件返回字典列表，带 docstring 和类型注解，处理文件不存在的情况。" --timeout 90 --json 2>&1 | tail -3
```

> ⚠️ **L2 首次 induction 的已知坑**：
>   新 policy 创建时 `l2.ts` 的 gain 计算会把 induction 证据全部归到
>   "without" 组，首次得分必为负，status 停在 candidate。**必须再跑一
>   通**，让 `associateTraces` 把新 trace 关联到已有 policy，support++，
>   gain 才翻正转 active。所以每个主题建议 3 通以上。

### 4.3 触发 L2 的另一个 bucket（让 L3 有可聚类的多条 policy）

换一个不同 signature 但 **policy body 仍命中同一个 L3 tag** 的主题。
例如 python+pytest 会落进 `python|test|_|_` bucket，但 policy body 还
是命中 `python` regex：

```bash
openclaw agent --session-id pytest-1 --message "用 pytest 给这个 Python 函数写单元测试：def add(a, b): return a+b。要求覆盖正常和边界情况。" --timeout 90 --json 2>&1 | tail -3
openclaw agent --session-id pytest-2 --message "用 pytest 给这个 Python 函数写单元测试：def divide(a, b): return a/b。要求覆盖除零异常。" --timeout 90 --json 2>&1 | tail -3
openclaw agent --session-id pytest-3 --message "用 pytest 给这个 Python 函数写单元测试：def is_palindrome(s: str) -> bool。要求覆盖空串、单字符、普通情况。" --timeout 90 --json 2>&1 | tail -3
openclaw agent --session-id pytest-4 --message "用 pytest + fixtures 给这个函数写单元测试：def load_json(path: str) -> dict。需要 mock 文件系统。" --timeout 90 --json 2>&1 | tail -3
```

> 为什么要 4 通：前两通让 pytest 这个 signature bucket 凑齐 2 episode
> → 触发 induction；第三、四通是为了让关联生效把 policy 转 active。

### 4.4 触发 L3 环境认知

`l3.subscriber` 只监听 `l2.policy.induced`，不会在 `policy.updated →
active` 时补跑。所以需要**再引入一个新 signature**，让它的 induction
事件顺便把前面已经 active 的同族 policy 拉进 cluster：

```bash
openclaw agent --session-id jwt-1 --message "用 Python 写一个 JWT token 的生成与校验函数，使用 PyJWT 库，带 docstring 和类型注解。" --timeout 90 --json 2>&1 | tail -3
openclaw agent --session-id jwt-2 --message "用 Python 写一个 FastAPI 的依赖注入函数，校验请求头里的 JWT token，返回用户信息。" --timeout 90 --json 2>&1 | tail -3
openclaw agent --session-id jwt-3 --message "用 Python 实现一个简单的 OAuth2 client credentials 认证流程，带 docstring 和类型注解。" --timeout 90 --json 2>&1 | tail -3
```

这一轮 induction 触发后，L3 会把 `python|_` cluster 下所有 active
policy（前面的 Python + pytest 两条）聚成一个 world model。

### 4.5 推荐最小脚本

把上面的串在一起（约 5~8 分钟跑完）：

```bash
for i in py-1 py-2 py-3 pytest-1 pytest-2 pytest-3 pytest-4 jwt-1 jwt-2 jwt-3; do
  # 每个 session 的 message 需要手动填；见上面分组
  echo "(请依次 copy 上面的命令)"
done
# 全跑完后至少 sleep 40s 等 pipeline 收尾
sleep 40
```

---

## 5. 校验数据库

统一用 `sqlite3` 查 `~/.openclaw/memos-plugin/data/memos.db`。

### 5.1 一键体检

```bash
sqlite3 ~/.openclaw/memos-plugin/data/memos.db <<'SQL'
SELECT '==== 四层数据层 ====';
SELECT 'L1 traces' layer, COUNT(*) n FROM traces
 UNION ALL SELECT 'episodes (tasks)', COUNT(*) FROM episodes
 UNION ALL SELECT 'L2 policies (active)', COUNT(*) FROM policies WHERE status='active'
 UNION ALL SELECT 'L2 policies (candidate)', COUNT(*) FROM policies WHERE status='candidate'
 UNION ALL SELECT 'L3 world_model', COUNT(*) FROM world_model
 UNION ALL SELECT 'skills', COUNT(*) FROM skills;

SELECT '==== L2 policies ====';
SELECT id, substr(title, 1, 60), status, support, printf('%.2f', gain) FROM policies;

SELECT '==== L3 world_model ====';
SELECT id, title, printf('%.2f', confidence), length(body), json_array_length(policy_ids_json)
  FROM world_model;

SELECT '==== Skills ====';
SELECT id, name, status, printf('%.2f', eta), support, printf('%.2f', gain) FROM skills;

SELECT '==== api_logs ====';
SELECT tool_name, COUNT(*), SUM(success) FROM api_logs GROUP BY tool_name ORDER BY tool_name;
SQL
```

### 5.2 合格标准

| 层                     | 合格标志                                              |
|------------------------|-------------------------------------------------------|
| L1 traces              | 数量 = 发出的 `openclaw agent` 次数                   |
| episodes               | 全部 `status=closed`，大部分 `r_task > 0`             |
| L2 policies (active)   | ≥ 1 条（3.1 里 3+ 通同族对话就应出一条 active）       |
| L3 world_model         | ≥ 1 条（4.4 跑完后）                                  |
| skills                 | ≥ 1 条；起始 status 是 `probationary`                 |
| api_logs.tool_name     | `memory_add` / `policy_generate` / `policy_evolve` / `skill_generate` / `world_model_generate` / `task_done` 都有记录 |

### 5.3 HTTP 接口直接验

如果需要跳过前端直接看接口返回：

```bash
# 提取 session cookie（绕过 viewer 登录）
SESS=$(python3 -c "import json,hmac,hashlib,base64; \
s=json.load(open('$HOME/.openclaw/memos-plugin/.auth.json')); \
body=base64.urlsafe_b64encode(json.dumps({'iat':0,'exp':9999999999999}).encode()).decode().rstrip('='); \
mac=base64.urlsafe_b64encode(hmac.new(base64.b64decode(s['sessionSecret']), body.encode(), hashlib.sha256).digest()).decode().rstrip('='); \
print(body+'.'+mac)")

curl -s -b "memos_sess=$SESS" 'http://127.0.0.1:18799/api/v1/skills'        | python3 -m json.tool
curl -s -b "memos_sess=$SESS" 'http://127.0.0.1:18799/api/v1/policies'      | python3 -m json.tool
curl -s -b "memos_sess=$SESS" 'http://127.0.0.1:18799/api/v1/world-models'  | python3 -m json.tool
curl -s -b "memos_sess=$SESS" 'http://127.0.0.1:18799/api/v1/traces?limit=5' | python3 -m json.tool
```

---

## 6. 常见问题排查

| 症状                                               | 原因                                                                                                  |
|----------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `L1 traces = 0` 但调用成功                         | capture 订阅者异步写入，等 30 s 再查。还不行就 `tail -f ~/.openclaw/memos-plugin/logs/*` 看错误       |
| traces 大部分 `value = 0`                          | reward 没评分成功：LLM apiKey 失效 / endpoint 不可达。查 `api_logs` 里 `task_done.success`             |
| traces 大部分 `vec_summary IS NULL`                | embedding 服务不可达。查 `config.yaml` 里的 `embedding.endpoint`                                      |
| L2 policies 永远是 candidate                       | 见 4.2 的已知坑：同一 signature 再跑一通让 `associateTraces` 把 support++                             |
| 所有 Python 问题都合成一个 policy                  | `l2Induction.minSimilarity` 太低。保持 0.72                                                           |
| L3 world_model = 0                                 | policy 虽 active 但都没落进同一个 domainKey / cluster 太小；照 4.4 那样再触发一次 induction           |
| `openclaw plugins list` 报 "failed during register" | 通常是 openclaw 自身 SDK 版本与插件 service.id 字段要求不匹配；检查 `adapters/openclaw/index.ts` 里 `registerService({ id, name, … })` 两个字段都要填 |
| port 18799 一直被占                                 | `openclaw-gateway` daemon 会自动重启；用 `lsof -i :18799` 找 pid 然后 `kill -9`                       |

---

## 6.5 验证新增功能

### 6.5.1 技能版本 + 进化时间线

让同一个 signature 的 policy 再被新证据更新一次，触发 `skill.rebuilt`：

```bash
# 同一族主题跑更多 episode，让现有 policy 累积 support
for i in 1 2 3; do
  openclaw agent --session-id pytest-more-$i-$(date +%s) \
    --message "用 pytest 为下面函数写单元测试：def is_even(n:int)->bool" \
    --timeout 90 --json 2>&1 | tail -1
  sleep 3
done

# 等 30s 让 reward + skill 订阅者跑完
sleep 30

# 查 skills：至少一条的 version 应该 ≥ 2，并且 api_logs 里
# 有对应的 skill_generate / skill_evolve 事件
sqlite3 ~/.openclaw/memos-plugin/data/memos.db <<'SQL'
SELECT id, name, status, version, datetime(updated_at/1000, 'unixepoch', 'localtime') AS updated
FROM skills
ORDER BY updated_at DESC;
SELECT tool_name, substr(output_json, 1, 120), datetime(called_at/1000, 'unixepoch', 'localtime')
FROM api_logs
WHERE tool_name LIKE 'skill_%'
ORDER BY called_at DESC LIMIT 10;
SQL
```

前端：打开 **技能 → 某条 skill 详情**，应看到：
- 顶部 Metric 卡片里有 **当前版本 = v{N}** 和 **最后更新 {时间}**
- 最下方 **进化时间线** 卡片里列出 `crystallize.started / crystallized /
  rebuilt / eta.updated` 等事件

### 6.5.2 经验 avoid / prefer 分类

决策指引只在 feedback 管道触发"失败爆发"或用户显式否定反馈时才
attach 到 policy 上。最容易触发的方式是模拟一次工具失败爆发：

```bash
# 对同一个工具在同一 context 下连续报告 ≥ 3 次失败
# （依赖 core/feedback/signals.ts failureThreshold=3 默认）
#
# 这需要 openclaw agent 实际调一个会失败的工具，并由
# before_tool_call / after_tool_call 记录 recordToolOutcome。
# 单条命令不容易制造，推荐通过前端 viewer 的 Memories 抽屉
# 给某条 trace 打 thumbs-down 直接下发一条 feedback：

curl -s -b "memos_sess=$SESS" -X POST \
  'http://127.0.0.1:18799/api/v1/feedback' \
  -H 'content-type: application/json' \
  -d '{"traceId":"tr_xxx","channel":"explicit","polarity":"negative","magnitude":1,"rationale":"这种做法以后别用"}'

# 等 feedback → synthesizeDraft → attachRepairToPolicies 完成
sleep 10

# 查 policy 的 preference / antiPattern
curl -s -b "memos_sess=$SESS" 'http://127.0.0.1:18799/api/v1/policies' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);[print(p['id'],'prefs=',p.get('preference'),'avoids=',p.get('antiPattern')) for p in d['policies']]"
```

前端：**经验** 页面列表卡片应该出现绿色 `偏好 N` / 红色 `避免 N`
胶囊；点进详情，底部有两段结构化列表（推荐做法 / 避免做法）。

### 6.5.3 L3 环境认知注入

L3 环境知识会在每次 turn 开始时通过 `prependContext` 注入 prompt
（见 `adapters/openclaw/bridge.ts::renderContextBlock`）。不需要额外
验证；看 memory_search api_logs 的 `candidates[]` 里出现 `tier=3,
refKind=world-model` 即可。

此外新增了 `memory_environment` 工具，让 agent 可以在 tool-call
阶段按需再查一次环境知识：

```bash
# agent 调用示例（通过 openclaw）
openclaw agent --session-id env-probe-$(date +%s) \
  --message "先用 memory_environment 查这个项目相关的环境知识，再回答：项目里 pytest 测试应该放在哪个目录？" \
  --timeout 90 --json
```

### 6.5.4 技能进化模型配置持久性

在 **设置 → AI 模型 → 技能进化** 填入 provider + model + apiKey，
点保存，页面自动重启刷新。再次打开设置页应看到填入的值。

验证流程（无前端）：

```bash
curl -s -b "memos_sess=$SESS" -X PATCH \
  'http://127.0.0.1:18799/api/v1/config' \
  -H 'content-type: application/json' \
  -d '{"skillEvolver":{"provider":"openai_compatible","model":"claude-sonnet-4","endpoint":"...","apiKey":"..."}}'

# 不需要重启 gateway，直接 GET 应返回最新值（本次修复点）
curl -s -b "memos_sess=$SESS" 'http://127.0.0.1:18799/api/v1/config' \
  | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin).get('skillEvolver'), indent=2))"
```

---

## 7. 恢复默认

测试做完记得把 `config.yaml` 里的 `algorithm:` 段删除或改回默认，否则
线上会大量误结晶。

```bash
# 如果只是想换回默认，直接把 algorithm: 段整个删掉即可
# 代码里的默认值在 core/config/defaults.ts
```

---

## 8. 参考

- `core/memory/l2/l2.ts`  ─ L2 induction 主流程
- `core/memory/l2/signature.ts` ─ signature 生成规则
- `core/memory/l3/l3.ts`  ─ L3 abstraction 主流程
- `core/memory/l3/cluster.ts` ─ L3 cluster 键规则
- `core/skill/subscriber.ts`  ─ skill 触发条件
- `core/capture/tagger.ts`    ─ 标签识别关键字
- 前端视图：`web/src/views/{Memories,Tasks,Skills,Policies,WorldModels}View.tsx`
- 算法设计文档：`../memos-local-openclaw/算法设计_Reflect2Skill_V7_核心详解.md`
