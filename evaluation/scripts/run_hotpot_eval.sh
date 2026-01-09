#!/bin/bash
set -e

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"
export PYTHONPATH="$ROOT_DIR"

# Common parameters
LIB="mem0"
WORKERS=20
TOPK=7
ADD_MODE="fine"
SEARCH_MODE="fine"
VERSION_DIR="test_0101_07"
ASYNC_MODE="sync"
CHAT_MODEL="gpt-4o-mini"
LIMIT=100

# Add / Ingestion
#echo "Running hotpot_ingestion.py..."
#python -m evaluation.scripts.hotpot.hotpot_ingestion \
#  --lib "$LIB" \
#  --workers "$WORKERS" \
#  --version-dir "$VERSION_DIR" \
#  --mode "$ADD_MODE" \
#  --async-mode "$ASYNC_MODE" \
#  --limit "$LIMIT"

# Search
#echo "Running hotpot_search.py..."
#python -m evaluation.scripts.hotpot.hotpot_search \
#  --lib "$LIB" \
#  --workers "$WORKERS" \
#  --version-dir "$VERSION_DIR" \
#  --top-k "$TOPK" \
#  --search-mode "$SEARCH_MODE" \
#  --limit "$LIMIT"

# Eval
echo "Running hotpot_eval.py..."
python -m evaluation.scripts.hotpot.hotpot_eval \
  --lib "$LIB" \
  --version-dir "$VERSION_DIR" \
  --workers "$WORKERS" \
  --search-mode "$SEARCH_MODE" \
  --chat-model "$CHAT_MODEL"

echo "All scripts completed successfully!"
