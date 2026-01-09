#!/bin/bash
set -e

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"
export PYTHONPATH="$ROOT_DIR"

# Common parameters
LIB="supermemory"
WORKERS=10
TOPK=20
ADD_MODE="fine"
SEARCH_MODE="fine"
VERSION_DIR="test_1230"
ASYNC_MODE="sync"
CHAT_MODEL="gpt-4o-mini"

## Add / Ingestion
#echo "Running mmlongbench_ingestion.py..."
#python -m evaluation.scripts.mmlongbench.mmlongbench_ingestion \
#  --lib "$LIB" \
#  --workers "$WORKERS" \
#  --version-dir "$VERSION_DIR" \
#  --mode "$ADD_MODE" \
#  --async-mode "$ASYNC_MODE"
#
## Search
#echo "Running mmlongbench_search.py..."
#python -m evaluation.scripts.mmlongbench.mmlongbench_search \
#  --lib "$LIB" \
#  --workers "$WORKERS" \
#  --version-dir "$VERSION_DIR" \
#  --top-k "$TOPK" \
#  --mode "$SEARCH_MODE"

# Eval
echo "Running mmlongbench_eval.py..."
python -m evaluation.scripts.mmlongbench.mmlongbench_eval \
  --lib "$LIB" \
  --version-dir "$VERSION_DIR" \
  --workers "$WORKERS" \
  --chat-model "$CHAT_MODEL"

echo "All scripts completed successfully!"
