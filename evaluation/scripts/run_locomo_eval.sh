#!/bin/bash

# Common parameters for all scripts
LIB="memos"
VERSION="063001"
WORKERS=10
TOPK=20

echo "Running locomo_ingestion.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/locomo/locomo_ingestion.py --lib $LIB --version $VERSION --workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error running locomo_ingestion.py"
    exit 1
fi

echo "Running locomo_search.py..."
CUDA_VISIBLE_DEVICES=0 python scripts/locomo/locomo_search.py --lib $LIB --version $VERSION --top_k $TOPK --workers $WORKERS
if [ $? -ne 0 ]; then
    echo "Error running locomo_search.py"
    exit 1
fi

echo "Running locomo_responses.py..."
python scripts/locomo/locomo_responses.py --lib $LIB --version $VERSION
if [ $? -ne 0 ]; then
    echo "Error running locomo_responses.py."
    exit 1
fi

echo "Running locomo_eval.py..."
python scripts/locomo/locomo_eval.py --lib $LIB --version $VERSION --workers $WORKERS --num_runs 3
if [ $? -ne 0 ]; then
    echo "Error running locomo_eval.py"
    exit 1
fi

echo "Running locomo_metric.py..."
python scripts/locomo/locomo_metric.py --lib $LIB --version $VERSION
if [ $? -ne 0 ]; then
    echo "Error running locomo_metric.py"
    exit 1
fi

echo "All scripts completed successfully!"

echo "The complete evaluation steps for generating the RAG and full context of mem0!"

echo "Running mem0_rag.py..."
python scripts/locomo/mem0_rag.py --chunk_size 500 --num_chunks 1 --output_folder results/
if [ $? -ne 0 ]; then
    echo "Error running mem0_rag.py"
    exit 1
fi

echo "Mem0 rag files have been generated!"

echo "Running mem0_eval.py..."
python scripts/locomo/mem0_eval.py
if [ $? -ne 0 ]; then
    echo "Error running mem0_evla.py"
    exit 1
fi

echo "Mem0 eval files have been generated!"

echo "Running locomo_eval.py..."
python scripts/locomo/locomo_eval.py --lib mem0
if [ $? -ne 0 ]; then
    echo "Error running mem0_evla.py"
    exit 1
fi

echo "Generate an evaluation file in locomo format!"

echo "Running locomo_metric.py..."
python scripts/locomo/locomo_metric.py --lib mem0
if [ $? -ne 0 ]; then
    echo "Error running locomo_metric.py"
    exit 1
fi
echo "Evaluation score generation under mem0 framework"
