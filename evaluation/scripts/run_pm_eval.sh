#!/bin/bash

# Common parameters for all scripts
LIB="memos-api"
VERSION="072201"
WORKERS=10
TOPK=20

# echo "downloading data..."
# export HF_ENDPOINT=https://hf-mirror.com
# huggingface-cli download --repo-type dataset bowen-upenn/PersonaMem --local-dir /mnt/afs/codes/ljl/MemOS/evaluation/data/personamem

echo "Running pm_ingestion.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/personamem/pm_ingestion.py --lib $LIB --version $VERSION --workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error running pm_ingestion.py"
    exit 1
fi

echo "Running pm_search.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/personamem/pm_search.py --lib $LIB --version $VERSION --top_k $TOPK --workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error running pm_search.py"
    exit 1
fi

echo "Running pm_responses.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/personamem/pm_responses.py --lib $LIB --version $VERSION --workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error running pm_responses.py"
    exit 1
fi

echo "Running pm_metric.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/personamem/pm_metric.py --lib $LIB --version $VERSION
if [ $? -ne 0 ]; then
    echo "Error running pm_metric.py"
    exit 1
fi

echo "All scripts completed successfully!"
