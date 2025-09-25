#!/bin/bash

# --- Configuration ---
# This script runs the PrefEval pipeline in three steps.
# You can configure the number of workers for parallel processing here.

# Number of workers for scripts that support parallel execution
WORKERS=10

# Set the Hugging Face mirror endpoint
export HF_ENDPOINT="https://hf-mirror.com"

echo "--- Starting PrefEval Pipeline ---"
echo "Configuration: WORKERS=$WORKERS, HF_ENDPOINT=$HF_ENDPOINT"
echo ""

# --- Step 1: Preprocess the data ---
echo "Running prefeval_preprocess.py..."
python scripts/PrefEval/prefeval_preprocess.py
# Check if the last command executed successfully
if [ $? -ne 0 ]; then
    echo "Error: Data preprocessing failed."
    exit 1
fi

# --- Step 2: Generate responses using MemOS ---
echo ""
echo "Running pref_memos.py..."
# Pass the WORKERS variable to the script's --max-workers argument
python scripts/PrefEval/pref_memos.py --max-workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error: Response generation with MemOS failed."
    exit 1
fi

# --- Step 3: Evaluate the generated responses ---
echo ""
echo "Running pref_eval.py..."
# Pass the WORKERS variable to the script's --concurrency-limit argument
python scripts/PrefEval/pref_eval.py --concurrency-limit $WORKERS
if [ $? -ne 0 ]; then
    echo "Error: Evaluation script failed."
    exit 1
fi

echo ""
echo "--- PrefEval Pipeline completed successfully! ---"