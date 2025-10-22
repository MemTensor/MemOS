# #!/bin/bash

# # --- Configuration ---
# # This script runs the PrefEval pipeline in three steps.

# # Number of workers for parallel processing.
# # This variable controls both pref_memos.py (--max-workers)
# # and pref_eval.py (--concurrency-limit).
# WORKERS=10

# # Parameters for pref_memos.py
# TOP_K=10
# ADD_TURN=10  # Options: 0, 10, or 300
# LIB="memos-api" 
# VERSION="1021-8"  

# # --- File Paths ---
# # You may need to adjust these paths based on your project structure.
# # Assumes Step 1 (preprocess) outputs this file:
# PREPROCESSED_FILE="data/prefeval/pref_processed.jsonl" 

# # Intermediate file (output of 'add' mode, input for 'process' mode)
# IDS_FILE="results/prefeval/pref_memos_add.jsonl"

# # Final response file (output of 'process' mode, input for Step 3)
# RESPONSE_FILE="results/prefeval/pref_memos_process.jsonl"


# # Set the Hugging Face mirror endpoint
# export HF_ENDPOINT="https://hf-mirror.com"

# echo "--- Starting PrefEval Pipeline ---"
# echo "Configuration: WORKERS=$WORKERS, TOP_K=$TOP_K, ADD_TURN=$ADD_TURN, LIB=$LIB, VERSION=$VERSION, HF_ENDPOINT=$HF_ENDPOINT"
# echo ""

# # --- Step 1: Preprocess the data ---
# echo "Running prefeval_preprocess.py..."
# python scripts/PrefEval/prefeval_preprocess.py
# # Check if the last command executed successfully
# if [ $? -ne 0 ]; then
#     echo "Error: Data preprocessing failed."
#     exit 1
# fi

# # --- Step 2: Generate responses using MemOS (split into 'add' and 'process') ---
# echo ""
# echo "Running pref_memos.py in 'add' mode..."
# # Step 2a: Ingest conversations into memory and generate user_ids
# python scripts/PrefEval/pref_memos.py add \
#     --input $PREPROCESSED_FILE \
#     --output $IDS_FILE \
#     --add-turn $ADD_TURN \
#     --max-workers $WORKERS \
#     --lib $LIB \
#     --version $VERSION

# if [ $? -ne 0 ]; then
#     echo "Error: pref_memos.py 'add' mode failed."
#     exit 1
# fi

# echo ""
# echo "Running pref_memos.py in 'process' mode..."
# # Step 2b: Search memories using user_ids and generate responses
# python scripts/PrefEval/pref_memos.py process \
#     --input $IDS_FILE \
#     --output $RESPONSE_FILE \
#     --top-k $TOP_K \
#     --max-workers $WORKERS \
#     --lib $LIB \
#     --version $VERSION

# if [ $? -ne 0 ]; then
#     echo "Error: pref_memos.py 'process' mode failed."
#     exit 1
# fi

# # --- Step 3: Evaluate the generated responses ---
# echo ""
# echo "Running pref_eval.py..."
# # Pass the WORKERS variable to the script's --concurrency-limit argument
# python scripts/PrefEval/pref_eval.py --concurrency-limit $WORKERS
# if [ $? -ne 0 ]; then
#     echo "Error: Evaluation script failed."
#     exit 1
# fi

# echo ""
# echo "--- PrefEval Pipeline completed successfully! ---"


#!/bin/bash

# --- Configuration ---
# This script runs the PrefEval pipeline in three steps.

# Number of workers for parallel processing.
# This variable controls both pref_memos.py (--max-workers)
# and pref_eval.py (--concurrency-limit).
WORKERS=10

# Parameters for pref_memos.py
TOP_K=6
ADD_TURN=0  # Options: 0, 10, or 300
LIB="memos-api" 
VERSION="1022-0"  

# --- File Paths ---
# You may need to adjust these paths based on your project structure.
# Step 1 (preprocess) outputs this file:
PREPROCESSED_FILE="data/prefeval/pref_processed.jsonl" 

# Create a directory name based on LIB and VERSION
OUTPUT_DIR="results/prefeval/${LIB}_${VERSION}"

# Intermediate file (output of 'add' mode, input for 'search' mode)
IDS_FILE="${OUTPUT_DIR}/pref_memos_add.jsonl"

# Intermediate file (output of 'search' mode, input for 'response' mode)
SEARCH_FILE="${OUTPUT_DIR}/pref_memos_search.jsonl"

# Final response file (output of 'response' mode, input for Step 3)
RESPONSE_FILE="${OUTPUT_DIR}/pref_memos_response.jsonl"


# Set the Hugging Face mirror endpoint
export HF_ENDPOINT="https://hf-mirror.com"

echo "--- Starting PrefEval Pipeline ---"
echo "Configuration: WORKERS=$WORKERS, TOP_K=$TOP_K, ADD_TURN=$ADD_TURN, LIB=$LIB, VERSION=$VERSION, HF_ENDPOINT=$HF_ENDPOINT"
echo "Results will be saved to: $OUTPUT_DIR"
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

# --- Step 2: Generate responses using MemOS (split into 'add', 'search', and 'response') ---
echo ""
echo "Running pref_memos.py in 'add' mode..."
# Step 2a: Ingest conversations into memory and generate user_ids
python scripts/PrefEval/pref_memos.py add \
    --input $PREPROCESSED_FILE \
    --output $IDS_FILE \
    --add-turn $ADD_TURN \
    --max-workers $WORKERS \
    --lib $LIB \
    --version $VERSION

if [ $? -ne 0 ]; then
    echo "Error: pref_memos.py 'add' mode failed."
    exit 1
fi

echo ""
echo "Running pref_memos.py in 'search' mode..."
# Step 2b: Search memories using user_ids
python scripts/PrefEval/pref_memos.py search \
    --input $IDS_FILE \
    --output $SEARCH_FILE \
    --top-k $TOP_K \
    --max-workers $WORKERS

if [ $? -ne 0 ]; then
    echo "Error: pref_memos.py 'search' mode failed."
    exit 1
fi

echo ""
echo "Running pref_memos.py in 'response' mode..."
# Step 2c: Generate responses based on searched memories
python scripts/PrefEval/pref_memos.py response \
    --input $SEARCH_FILE \
    --output $RESPONSE_FILE \
    --max-workers $WORKERS

if [ $? -ne 0 ]; then
    echo "Error: pref_memos.py 'response' mode failed."
    exit 1
fi

# --- Step 3: Evaluate the generated responses ---
echo ""
echo "Running pref_eval.py..."
python scripts/PrefEval/pref_eval.py \
    --input $RESPONSE_FILE \
    --concurrency-limit $WORKERS
    
if [ $? -ne 0 ]; then
    echo "Error: Evaluation script failed."
    exit 1
fi

echo ""
echo "--- PrefEval Pipeline completed successfully! ---"
echo "Final results are in $RESPONSE_FILE"