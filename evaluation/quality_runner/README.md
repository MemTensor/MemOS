# MemOS Quality Pack Runner

这个适配器把 Quality Packs `0708cc0` 中的
`datasets/memos/memos-golden-recall-v0-runner-20261017` 读取成统一的
`EvaluationRun` 报告。它有三种模式：

- `shadow` 和 `mock` **不调用模型、不访问网络、不生成 recall accuracy**，只验证
  manifest、文件 SHA-256、样本绑定、样本覆盖和 fixture 引用完整性；结果明确标记为
  `result: not_available`。
- `live` 只有在调用方显式提供 `--target-url` 时才会执行。它逐条 POST 同一份 Quality
  Pack 的 `query` 和 `memories` 到 HTTP JSON target，要求 target 返回绑定的 `sampleId`、
  `targetOutput` 和 `evidenceRefs`，并采集可选的 latency/token/cost 字段。任意网络、协议
  或样本绑定错误都会让整个 run 失败，不会输出部分成功报告。

```bash
python -m evaluation.quality_runner.memos_quality_runner \
  --quality-packs-root /path/to/quality-packs \
  --dataset-id memos-golden-recall-v0-runner-20261017 \
  --mode shadow \
  --output /tmp/memos-evaluation-run.json
```

`live` 示例（token 只从环境变量读取，不放在命令行、不写入报告）：

```bash
export MEMOS_EVAL_TARGET_TOKEN='local-or-managed-secret'
python -m evaluation.quality_runner.memos_quality_runner \
  --quality-packs-root /path/to/quality-packs \
  --dataset-id memos-golden-recall-v0-runner-20261017 \
  --mode live \
  --target-url http://127.0.0.1:9000/evaluate \
  --target-token-env MEMOS_EVAL_TARGET_TOKEN \
  --target-timeout-seconds 15 \
  --output /tmp/memos-evaluation-live.json
```

target 请求体使用 `memos-eval-target-request.v1`，包含 `runId`、`sampleId`、产品和
dataset 绑定、`query`、`memories` 及 Quality Pack content hash；不会包含 `goldenAnswer`
或 `acceptableAnswers`。target 响应必须是 `application/json` 对象：

```json
{
  "sampleId": "memos-fixture-1",
  "traceId": "eval-run:memos-fixture-1",
  "targetOutput": "answer",
  "evidenceRefs": ["memory:abc"],
  "latencyMs": 42.1,
  "inputTokens": 12,
  "outputTokens": 19,
  "costMicros": 3
}
```

最后四个观测字段可以省略，省略后报告中保持 `null`；不能用 `0` 代替未知值。target
必须回显当前样本的 `sampleId` 和 runner 提供的 `traceId`，以防止跨样本结果串写。live 报告的 `result` 是
`available`，但 `scorecard.status` 仍为 `not_scored`：本适配器只负责安全采集，黄金答案
对比和正式 Gate 由可信评测服务完成。响应体上限为 1 MiB，单条 `targetOutput` 上限为
256 KiB，最多 64 条 `evidenceRefs` 且每条最多 1,024 个字符；超限会 fail closed。

Runner 会强制校验 manifest 的 `contentHash` 必须等于已读取样本文件的 SHA-256，并在
报告同时绑定 `datasetId`、数据集版本、完整 sample ID 列表和 manifest SHA。每个 live
样本请求携带确定性的 `traceId=<evaluationRunId>:<sampleId>`，target 必须原样回显；
缺少或串样本的 trace 会使整个 run fail closed。报告还包含 `runner.manifest`（版本、
entrypoint、命令模板和 output contract）以及 `evidence`（evaluationRunId、样本覆盖、
trace 覆盖和 `datasetContentHash`）。`reportSha256` 是对这些字段（不含 report 封套本身）
的 canonical JSON 摘要，可直接映射到 Badcase/QCP EvidenceRun 的报告摘要。

输出包括：

- `run`：产品、dataset/version、dataset content hash、目标 revision、Runner 版本和执行耗时；
- `items`：每条样本的 `status=not_available`、`fixtureMatch=pass`，以及空的 latency/token/cost 字段；
- `scorecard`：fixture 覆盖率和引用完整性，不伪装成模型质量分；
- `reportSha256`：对报告主体的 canonical JSON 计算的 SHA-256。

不能把 `fixtureMatchRate` 当作产品质量分数或准出证据；也不能把 `live` 的
`result: available` 解读为质量通过。生产接入前仍需要绑定目标服务的身份、网络策略、
可信评分服务和正式 Gate。

## MemMate 本机隔离闭环

`memos_local_isolated_eval.py` 是面向 MemMate 本地服务的 disposable smoke runner。它只接受 loopback URL（默认 `http://127.0.0.1:19760`），从 `MEMMY_MEMORY_TOKEN` 环境变量读取 token，不接受命令行 token，也不会连接云端地址。

每次运行生成唯一的 `quality-eval-shadow` namespace 和合成记忆，按以下顺序执行：

1. 在唯一 namespace 中预检检索，确认本次 marker 不存在；
2. `POST /api/v1/memory/add` 写入合成样本并等待 `processing/status` 到达 `ready`；
3. 在相同 namespace 中检索，要求返回本次 memory ID；
4. `DELETE /api/v1/memory/:id`，随后用 `GET` 返回 404 和再次检索不再出现 marker 做清理核验。

`ready` 与检索命中只说明本机处理链路和 recall 可用，不是黄金数据集分数、质量准出或生产 Gate。运行示例：

```bash
MEMMY_MEMORY_TOKEN="$MEMMY_MEMORY_TOKEN" python -m evaluation.quality_runner.memos_local_isolated_eval \
  --base-url http://127.0.0.1:19760 \
  --output reports/memos-local-isolated-eval-live-YYYY-MM-DD.json
```

报告只保存服务版本、namespace 标识、状态和内容哈希，不保存 token 或原始记忆内容。若 token 缺失、服务不健康、处理未进入 ready、检索未命中或删除核验失败，runner 会 fail closed；即使中途失败，也会在已拿到 memory ID 时尝试清理。
