# 记忆评测框架

本仓库提供了一套工具与脚本，用于在 `LoCoMo`、`LongMemEval`、`PrefEval`、`personaMem` 等数据集上，使用多种模型和 API 对记忆能力进行评测。

## 安装

1. 设置 `PYTHONPATH` 环境变量：
   ```bash
   export PYTHONPATH=../src
   cd evaluation  # 请从仓库根目录进入该目录
   ```

2. 安装所需依赖：
   ```bash
   poetry install --extras all --with eval
   ```

## 配置
将 `.env-example` 文件复制为 `.env`，并根据你的运行环境和 API Key，填写所需的环境变量。

## MemOS 部署
### 本地服务
```bash
# 修改 {project_dir}/.env 文件，然后启动服务
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001 --workers 8

# 配置 {project_dir}/evaluation/.env 文件
MEMOS_URL="http://127.0.0.1:8001"
```
### 在线服务
```bash
# 请在 https://memos-dashboard.openmem.net/cn/quickstart/ 申请你的 API Key
# 配置 {project_dir}/evaluation/.env 文件
MEMOS_KEY="Token mpg-xxxxx"
MEMOS_ONLINE_URL="https://memos.memtensor.cn/api/openmem/v1"

```

## 支持的框架
我们的脚本原生支持 `memos-api` 与 `memos-api-online`。
此外，还为以下记忆框架提供了非官方实现：`zep`、`mem0`、`memobase`、`supermemory`、`memu`。


## 评测脚本

### LoCoMo 评测
⚙️ 如需使用上述任一记忆框架对 **LoCoMo** 数据集进行评测，请运行以下 [脚本](../../../../evaluation/scripts/run_locomo_eval.sh)：

```bash
# 在 ./scripts/run_locomo_eval.sh 中修改配置
# 指定你想使用的模型和记忆后端（例如 mem0、zep 等）
evaluation/scripts/run_locomo_eval.sh
```

✍️ 如果你想在 LoCoMo 数据集上评测 OpenAI 原生的 Memory 能力，请参考详细指南：[OpenAI Memory on LoCoMo - 评测指南](./openai_memory_locomo_eval_guide.md)。

### LongMemEval 评测
首先从 https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned 下载数据集 `longmemeval_s`，并将其保存为 `data/longmemeval/longmemeval_s.json`。

```bash
# 在 evaluation/scripts/run_lme_eval.sh 中修改配置
# 指定你想使用的模型和记忆后端（例如 mem0、zep 等）
evaluation/scripts/run_lme_eval.sh
```

#### 关于问题日期与 `reference_time`

LongMemEval 为每个问题提供了一个 **问题日期（question date）**；评测时应将其作为参考的“现在”时间，而不是脚本实际运行时间。LongMemEval 的检索脚本会在后端支持的情况下，把 `question_date` 作为 **`reference_time`** 传入。

**MemOS Cloud** 目前还不支持以同样的方式在检索时传入问题日期，因此在 MemOS Cloud 上的 LongMemEval 得分可能与严格按照规范执行的结果存在差异。当你需要可对比的评测数据时，**建议优先在开源版本的 MemOS 服务上进行 LongMemEval 评测**。

### PrefEval 评测
从 https://github.com/amazon-science/PrefEval/blob/main/benchmark_dataset/filtered_inter_turns.json 下载 `benchmark_dataset/filtered_inter_turns.json`，并保存为 `./data/prefeval/filtered_inter_turns.json`。
如需在 **Prefeval** 数据集上进行评测，请运行以下 [脚本](evaluation/scripts/run_prefeval_eval.sh)：

```bash
# 在 evaluation/scripts/run_prefeval_eval.sh 中修改配置
# 指定你想使用的模型和记忆后端（例如 mem0、zep 等）
evaluation/scripts/run_prefeval_eval.sh
```

### PersonaMem 评测
从 https://huggingface.co/datasets/bowen-upenn/PersonaMem 下载 `questions_32k.csv` 与 `shared_contexts_32k.jsonl`，并保存到 `data/personamem/` 目录下。
```bash
# 在 evaluation/scripts/run_pm_eval.sh 中修改配置
# 指定你想使用的模型和记忆后端（例如 mem0、zep 等）
# 如需使用 MIRIX，请修改 evaluation/scripts/personamem/config.yaml 中的配置
evaluation/scripts/run_pm_eval.sh
```
