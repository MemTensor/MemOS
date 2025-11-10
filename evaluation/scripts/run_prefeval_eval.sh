#!/bin/bash

# --- Configuration ---
# This script runs the PrefEval pipeline in three steps.

# Number of workers for parallel processing.
# This variable controls both pref_memos.py (--max-workers)
# and pref_eval.py (--concurrency-limit).
WORKERS=20

# Parameters for pref_memos.py
TOP_K=10
ADD_TURN=10  # Options: 0, 10, or 300
LIB="memos-api"  # Options: memos-api, memos-api-online, mem0, mem0-graph, memobase, supermemory, memu, zep
VERSION="default"

# --- File Paths ---
# You may need to adjust these paths based on your project structure.
# Step 1 (preprocess) outputs this file:
PREPROCESSED_FILE="data/prefeval/pref_processed.jsonl"

# Create a directory name based on the *specific* LIB (e.g., "memos")
OUTPUT_DIR="results/prefeval/${LIB}_${VERSION}"


if [[ "$LIB" == *"mem0"* ]]; then
    SCRIPT_NAME_BASE="mem0"
elif [[ "$LIB" == *"memos"* ]]; then
    SCRIPT_NAME_BASE="memos"
elif [[ "$LIB" == *"memobase"* ]]; then
    SCRIPT_NAME_BASE="memobase"
elif [[ "$LIB" == *"supermemory"* ]]; then
    SCRIPT_NAME_BASE="supermemory"
elif [[ "$LIB" == *"memu"* ]]; then
    SCRIPT_NAME_BASE="memu"
elif [[ "$LIB" == *"zep"* ]]; then
    SCRIPT_NAME_BASE="zep"
else
    SCRIPT_NAME_BASE=$LIB
fi

# The script to be executed (e.g., pref_mem0.py)
LIB_SCRIPT="scripts/PrefEval/pref_${SCRIPT_NAME_BASE}.py"

# Output files will be unique to the $LIB (e.g., pref_memos-api_add.jsonl)
IDS_FILE="${OUTPUT_DIR}/pref_${LIB}_add.jsonl"
SEARCH_FILE="${OUTPUT_DIR}/pref_${LIB}_search.jsonl"
RESPONSE_FILE="${OUTPUT_DIR}/pref_${LIB}_response.jsonl"


# Set the Hugging Face mirror endpoint
export HF_ENDPOINT="https://hf-mirror.com"

echo "--- Starting PrefEval Pipeline ---"
echo "Configuration: WORKERS=$WORKERS, TOP_K=$TOP_K, ADD_TURN=$ADD_TURN, LIB=$LIB, VERSION=$VERSION, HF_ENDPOINT=$HF_ENDPOINT"
echo "Results will be saved to: $OUTPUT_DIR"
echo "Using script: $LIB_SCRIPT (mapped from LIB=$LIB)"
echo ""

# --- Step 1: Preprocess the data ---
echo "Running prefeval_preprocess.py..."
python scripts/PrefEval/prefeval_preprocess.py
# Check if the last command executed successfully
if [ $? -ne 0 ]; then
    echo "Error: Data preprocessing failed."
    exit 1
fi

# --- Create output directory ---
echo ""
echo "Creating output directory: $OUTPUT_DIR"
mkdir -p $OUTPUT_DIR
if [ $? -ne 0 ]; then
    echo "Error: Could not create output directory '$OUTPUT_DIR'."
    exit 1
fi

# Check if the *mapped* script exists
if [ ! -f "$LIB_SCRIPT" ]; then
    echo "Error: Script not found for library '$LIB' (mapped to $LIB_SCRIPT)"
    exit 1
fi

# --- Step 2: Generate responses based on LIB ---
echo ""
echo "--- Step 2: Generate responses using $LIB (3-Step Process) ---"

echo ""
echo "Running $LIB_SCRIPT in 'add' mode..."
# Step 2a: Ingest conversations into memory and generate user_ids
python $LIB_SCRIPT add \
    --input $PREPROCESSED_FILE \
    --output $IDS_FILE \
    --add-turn $ADD_TURN \
    --max-workers $WORKERS \
    --lib $LIB \
    --version $VERSION

if [ $? -ne 0 ]; then
    echo "Error: $LIB_SCRIPT 'add' mode failed."
    exit 1
fi

echo ""
echo "Running $LIB_SCRIPT in 'search' mode..."
# Step 2b: Search memories using user_ids
python $LIB_SCRIPT search \
    --input $IDS_FILE \
    --output $SEARCH_FILE \
    --top-k $TOP_K \
    --max-workers $WORKERS

if [ $? -ne 0 ]; then
    echo "Error: $LIB_SCRIPT 'search' mode failed."
    exit 1
fi

echo ""
echo "Running $LIB_SCRIPT in 'response' mode..."
# Step 2c: Generate responses based on searched memories
python $LIB_SCRIPT response \
    --input $SEARCH_FILE \
    --output $RESPONSE_FILE \
    --max-workers $WORKERS

if [ $? -ne 0 ]; then
    echo "Error: $LIB_SCRIPT 'response' mode failed."
    exit 1
fi

# --- Step 3: Evaluate the generated responses ---
echo ""
echo "Running pref_eval.py..."
python scripts/PrefEval/pref_eval.py \
    --input $RESPONSE_FILE \
    --concurrency-limit $WORKERS \
    --lib $LIB

if [ $? -ne 0 ]; then
    echo "Error: Evaluation script failed."
    exit 1
fi

echo ""
echo "--- PrefEval Pipeline completed successfully! ---"
echo "Final results are in $RESPONSE_FILE"
