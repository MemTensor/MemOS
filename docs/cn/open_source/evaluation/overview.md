# 记忆评估框架

本仓库提供了使用各种模型和 API 对 `LoCoMo`、`LongMemEval`、`PrefEval`、`personaMem` 数据集进行评估的工具和脚本。


## 环境安装

1. 设置 `PYTHONPATH` 环境变量：
   ```bash
   export PYTHONPATH=../src
   cd evaluation  # 请在仓库根目录执行
   ```

2. 安装依赖：
   ```bash
   poetry install --extras all --with eval
   ```

## 配置说明
将 .env-example 文件复制一份并重命名为 .env，然后根据你的环境和 API 密钥，填写所需的环境变量。

## 安装 MemOS
### 本地服务
```bash
# 修改 {project_dir}/.env 文件并启动服务器
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001 --workers 8

# 配置 {project_dir}/evaluation/.env 文件
MEMOS_URL="http://127.0.0.1:8001"
```
### 在线服务
```bash
# 请访问 https://memos-dashboard.openmem.net/cn/quickstart/ 获取您的 API 密钥
# 获取到API密钥后，将密钥配置到 {project_dir}/evaluation/.env 文件中
MEMOS_KEY="Token mpg-xxxxx"
MEMOS_ONLINE_URL="https://memos.memtensor.cn/api/openmem/v1"

```
## 支持的框架

脚本支持 `memos-api` 和 `memos-api-online`。同时，我们为以下记忆框架提供了非官方实现：`zep`、`mem0`、`memobase`、`supermemory`、`memu`。

## 评估脚本

### LoCoMo 评估

⚙️ 使用支持的记忆框架之一评估 **LoCoMo** 数据集 —— 运行以下脚本：

```bash
# 编辑 ./scripts/run_locomo_eval.sh 中的配置
# 指定要使用的模型和记忆后端（例如 mem0、zep 等）
evaluation/scripts/run_locomo_eval.sh
```

✍️ 如需使用 OpenAI 的原生记忆功能评估 LoCoMo 数据集，请参考详细指南：[OpenAI Memory on LoCoMo - 评估指南](./openai_memory_locomo_eval_guide.md)。

### LongMemEval 评估

首先从 https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned 下载数据集 `longmemeval_s`，并将其保存为 `data/longmemeval/longmemeval_s.json`

```bash
# 编辑 evaluation/scripts/run_lme_eval.sh 中的配置
# 指定要使用的模型和记忆后端（例如 mem0、zep 等）
evaluation/scripts/run_lme_eval.sh
```

#### 问题日期与 `reference_time`

LongMemEval 为每个问题提供了一个**问题日期**；评估时应以该日期作为“当前时间”参考，而不是运行脚本时的实际时间。LongMemEval 搜索脚本会将 `question_date` 作为 **`reference_time`** 传递给支持该参数的后端。

**MemOS Cloud** 目前不支持在搜索时提供问题日期，因此在该平台上的 LongMemEval 得分可能与完全遵循规范的运行结果存在差异。**如果需要获得可比较的数值，建议使用开源的 MemOS 服务器来评估 LongMemEval。**

### PrefEval 评估

从 https://github.com/amazon-science/PrefEval/blob/main/benchmark_dataset/filtered_inter_turns.json 下载 `benchmark_dataset/filtered_inter_turns.json`，并将其保存为 `./data/prefeval/filtered_inter_turns.json`。

要评估 **Prefeval** 数据集 —— 请运行以下脚本：

```bash
# 编辑 evaluation/scripts/run_prefeval_eval.sh 中的配置
# 指定要使用的模型和记忆后端（例如 mem0、zep 等）
evaluation/scripts/run_prefeval_eval.sh
```

### PersonaMem 评估

从 https://huggingface.co/datasets/bowen-upenn/PersonaMem 获取 `questions_32k.csv` 和 `shared_contexts_32k.jsonl`，并将其保存到 `data/personamem/` 目录下。

```bash
# 编辑 evaluation/scripts/run_pm_eval.sh 中的配置
# 指定要使用的模型和记忆后端（例如 mem0、zep 等）
# 如需使用 MIRIX，请编辑 evaluation/scripts/personamem/config.yaml 中的配置
evaluation/scripts/run_pm_eval.sh
```
