# LLM GCRA 限流

## 环境变量

限流只暴露两个环境变量，默认关闭。当前仅限制明确选中的模型。

```dotenv
MEMOS_LLM_RATE_LIMIT_ENABLED=false
MEMOS_LLM_RATE_LIMIT_RULES='{"gpt-4o-mini":{"qps":5,"burst":2,"max_wait_seconds":30,"queue_capacity":16,"retry_attempts":1}}'
```

`RULES` 是 JSON 对象，键为实际请求的模型名。每条规则只支持以下五个参数，省略时使用代码默认值：

| 参数 | 默认值 | 含义 |
|---|---:|---|
| qps | 5 | 全局持续放行速率；所有共享配额的 worker 合计 |
| burst | 2 | 空闲后最多立即放行的请求总数，不是 qps 加 burst |
| max_wait_seconds | 30 | 单次主/备用调用及其受控重试的累计许可等待预算，单位秒 |
| queue_capacity | 16 | 每进程、每模型的等待队列上限，包含正在申请的队首 |
| retry_attempts | 1 | 首次模型请求失败后最多重试次数；0 表示不重试 |

上述示例与代码默认值及 `docker/.env.example-full` 一致，默认不启用。需要限流时显式设置 `MEMOS_LLM_RATE_LIMIT_ENABLED=true`。参数是开源部署的保守起点，不代表供应商保证的配额；应按实际配额、共享环境、worker 数、排队等待及限流错误调整。QPS 限流不等于 token 吞吐或模型在途并发限制。

- 未配置 `RULES` 时，默认只选择 `gpt-4o-mini`，使用上述默认值。
- 显式配置 `RULES` 会替换整个模型规则集合；未列出的模型不受限流影响，不隐式追加默认模型。
- `RULES={}` 不限制任何模型；删除某个模型的条目即可取消该模型限流。
- `ENABLED=false` 关闭整个功能。
- 模型名不支持通配符；qps 必须为有限正数，burst 和容量为正整数，重试次数为非负整数。
- Shell/`.env` 示例的外层单引号用于保护 JSON；在部署平台直接填写环境变量值时，不包含外层单引号。

多个模型分别配置示例：

```dotenv
MEMOS_LLM_RATE_LIMIT_RULES='{"gpt-4o-mini":{"qps":5,"burst":2,"max_wait_seconds":30,"queue_capacity":16,"retry_attempts":1},"qwen-flash":{"qps":10,"burst":2,"max_wait_seconds":3,"queue_capacity":8,"retry_attempts":0}}'
```

第二个模型仅为示例，不默认启用。

## Redis 与加载

Redis 连接复用现有 `MEMSCHEDULER_REDIS_HOST/PORT/DB/USERNAME/PASSWORD/SSL`。缺少 host 时，第一次受控调用报配置错误；默认关闭时不创建 Redis 客户端。密码通过部署 Secret 注入。

Redis key 自动按模型生成，无需 scope：

```text
memos:llm:gcra:gpt-4o-mini
memos:llm:gcra:qwen-flash
```

同一 Redis/DB、相同前缀下，同名模型跨 worker/环境共享一个 TAT，不因 endpoint 或 API Key 不同而拆分。不同模型的 TAT 和本地队列独立；模型别名视为不同模型。各环境必须使用一致的速率和 burst。

配置在创建 LLM 配置对象时加载，不逐请求读环境变量，也不自行加载 `.env`。更新部署配置后需协调重启 worker。Python 显式 `rate_limit` 配置仍可覆盖环境值，配置对象保留内部运行参数用于程序化构造和测试；这些参数不再提供环境变量入口。

旧的 `MEMOS_LLM_RATE_LIMIT_*` 配置中，除 `ENABLED`、`RULES` 外均需移除，例如 MODELS、QPS、BURST、SCOPE、CONFIG_FILE、REDIS_* 和 WAIT_JITTER_SECONDS。加载时会对不支持的变量报错，避免旧配置被静默忽略。旧的模型规则中也应移除 enabled、scope、抖动及退避参数。不再支持通过环境变量指定独立 JSON 配置文件。

若从旧哈希 key 或旧前缀升级，请协调所有实例切换，避免新旧 key 同时放行；新 key 初始化时会恢复一个 burst。不要在运行中随意切换前缀。

## 内部行为

- Lua 使用 Redis TIME，原子读取、判断和更新 TAT，拒绝不推进 TAT；Python 使用 register_script，无需本机安装 Lua。
- 每进程、每模型只有队首申请 Redis，其他线程通过 Condition 等待。获准后立即离队发起模型调用，不等模型返回。
- Redis 建议等待时间后附加 0～10ms 抖动。无有效 Retry-After 时使用指数退避和抖动，退避基数 1s、上限 8s。这些是内部默认值，不需要部署配置。
- 受控调用关闭 SDK 隐藏重试。连接/超时错误及 HTTP 408、409、429、5xx 可有限重试，每次重新申请许可；Retry-After 超过内部等待上限时不提前重试。
- 流式请求只重试建立阶段，流开始后的错误不重放。调用方提前结束时应关闭生成器。
- 队列满、等待超时、Redis 不可用分别抛出 LLMRateLimitQueueFullError、LLMRateLimitTimeoutError、LLMRateLimitUnavailableError，不通过备用模型绕过。
- 默认 Redis 连接和读取超时 0.5s，故障策略为 closed，即停止受控调用。网络响应迟到时不发送模型请求，也不退还已消耗或状态不确定的许可。
- max_wait_seconds 不包含模型网络耗时和失败退避，不是整个业务请求的总超时；外层仍需业务 deadline。同步 Redis I/O 最迟要等 socket 超时才能退出。
- 本地队列不是持久任务队列；满队列、超时和进程退出不会自动延期任务。Redis 故障切换或淘汰 TAT 也可能重置额度。

## 范围与验证

当前接入 OpenAILLM 及其 Qwen、DeepSeek、MiniMax 子类的 Chat Completions，包括普通调用、流式建立和备用模型。Azure、Responses API、Ollama、VLLM 等独立实现暂未接入。

该版本仅控制 QPS，不控制 Token 用量、Token 增速或在途并发，不能保证解决供应商所有 429。

INFO 的 `[LLM_RATE_LIMIT] sending` 记录模型、尝试序号及许可等待时间；WARNING 记录重试、队列满、等待超时和 Redis 故障。新增日志不记录请求正文或凭据。

```sh
poetry run pytest tests/configs/ tests/llms/ -q
MEMOS_TEST_LOCAL_REDIS=1 poetry run pytest tests/llms/test_qps_rate_limit_redis.py -q
```

第二条启动隔离本地 Redis，仅 Unix socket、无 TCP、无持久化，不读取生产 Redis 配置。日志位于 pytest 管理的 `redis-gcra*` 临时目录；短路径临时 socket 退出时清理。
