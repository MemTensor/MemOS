# Evaluation Memory Framework

This repository provides tools and scripts for evaluating the `LoCoMo`, `LongMemEval`, `PrefEval`, `personaMem` dataset using various models and APIs.

## Installation

1. Set the `PYTHONPATH` environment variable:
   ```bash
   export PYTHONPATH=../src
   cd evaluation
   ```

2. Install the required dependencies:
   ```bash
   poetry install --extras all --with eval
   ```

## Configuration
Copy the `.env-example` file to `.env`, and fill in the required environment variables according to your environment and API keys.

## Setup MemOS
### local server
```bash
# modify {project_dir}/.env file and start server
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001 --workers 8

# configure {project_dir}/evaluation/.env file
MEMOS_URL="http://127.0.0.1:8001"
```
### online service
```bash
# get your api key at https://memos-dashboard.openmem.net/cn/quickstart/
# configure {project_dir}/evaluation/.env file
MEMOS_KEY="Token mpg-xxxxx"
MEMOS_ONLINE_URL="https://memos.memtensor.cn/api/openmem/v1"

```

## Supported frameworks
We support `memos-api` and `memos-api-online` in our scripts.
And give unofficial implementations for the following memory frameworks:`zep`, `mem0`, `memobase`, `supermemory`, `memu`.


## Evaluation Scripts

### LoCoMo Evaluation
⚙️ To evaluate the **LoCoMo** dataset using one of the supported memory frameworks — run the following [script](./scripts/run_locomo_eval.sh):

```bash
# Edit the configuration in ./scripts/run_locomo_eval.sh
# Specify the model and memory backend you want to use (e.g., mem0, zep, etc.)
./scripts/run_locomo_eval.sh
```

✍️ For evaluating OpenAI's native memory feature with the LoCoMo dataset, please refer to the detailed guide: [OpenAI Memory on LoCoMo - Evaluation Guide](./scripts/locomo/openai_memory_locomo_eval_guide.md).

### LongMemEval Evaluation
First prepare the dataset `longmemeval_s` from https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
, and save it as `data/longmemeval/longmemeval_s.json`

```bash
# Edit the configuration in ./scripts/run_lme_eval.sh
# Specify the model and memory backend you want to use (e.g., mem0, zep, etc.)
./scripts/run_lme_eval.sh
```

### PrefEval Evaluation
Downloading benchmark_dataset/filtered_inter_turns.json from https://github.com/amazon-science/PrefEval/blob/main/benchmark_dataset/filtered_inter_turns.json and save it as `./data/prefeval/filtered_inter_turns.json`.
To evaluate the **Prefeval** dataset — run the following [script](./scripts/run_prefeval_eval.sh):

```bash
# Edit the configuration in ./scripts/run_prefeval_eval.sh
# Specify the model and memory backend you want to use (e.g., mem0, zep, etc.)
./scripts/run_prefeval_eval.sh
```

### PersonaMem Evaluation
get `questions_32k.csv` and `shared_contexts_32k.jsonl` from https://huggingface.co/datasets/bowen-upenn/PersonaMem and save them at `data/personamem/`
```bash
# Edit the configuration in ./scripts/run_pm_eval.sh
# Specify the model and memory backend you want to use (e.g., mem0, zep, etc.)
# If you want to use MIRIX, edit the the configuration in ./scripts/personamem/config.yaml
./scripts/run_pm_eval.sh
```
