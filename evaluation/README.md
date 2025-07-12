# Evaluation Memory Framework

This repository provides tools and scripts for evaluating the LoCoMo dataset using various models and APIs.

## Installation

1. Set the `PYTHONPATH` environment variable:
   ```bash
   export PYTHONPATH=../src
   cd evaluation
   ```

2. Install the required dependencies:
   ```bash
   poetry install --with eval
   ```

## Configuration

1. Copy the `.env-example` file to `.env`, and fill in the required environment variables according to your environment and API keys.

2. Copy the `configs-example/` directory to a new directory named `configs/`, and modify the configuration files inside it as needed. This directory contains model and API-specific settings.


## Evaluation Scripts

### LoCoMo Evaluation
To evaluate the **LoCoMo** dataset using one of the supported memory frameworks — `memos`, `mem0`, or `zep` — run the following command:

```bash
# Edit the configuration in ./scripts/run_locomo_eval.sh
# Specify the model and memory backend you want to use (e.g., mem0, zep, etc.)
./scripts/run_locomo_eval.sh
```

### mem0 rag and full-context Evaluation
+ Step 1: You should generate the rag files of mem0 project.
+ Step 2: Generating the mem0 evaluation files
+ Step 3: Using locomo framework to generate evalution files(It is different with step2)
+ Step 4: Evaluation score generation under mem0 framework

For detailed execution steps, please refer to File:
```bash
./scripts/run_locomo_eval.sh
```
