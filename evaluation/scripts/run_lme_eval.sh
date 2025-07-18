#!/bin/bash

# Common parameters for all scripts
LIB="memos-local"
VERSION="071503"
WORKERS=10
TOPK=20

echo "Running lme_ingestion.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/longmemeval/lme_ingestion.py --lib $LIB --version $VERSION --workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error running lme_ingestion.py"
    exit 1
fi

echo "Running lme_search.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/longmemeval/lme_search.py --lib $LIB --version $VERSION --top_k $TOPK --workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error running lme_search.py"
    exit 1
fi

echo "All scripts completed successfully!"
