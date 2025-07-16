#!/bin/bash
LIB="mem0"
VERSION="default"

echo "The complete evaluation steps for generating the RAG and full context!"

echo "Running locomo_rag.py..."
python scripts/locomo/locomo_rag.py --chunk_size 512 --num_chunks 1 --output_folder results/locomo/mem0-default/
if [ $? -ne 0 ]; then
    echo "Error running locomo_rag.py"
    exit 1
fi
echo "✅locomo response files have been generated!"

echo "Running locomo_eval.py..."
python scripts/locomo/locomo_eval.py --lib $LIB
if [ $? -ne 0 ]; then
    echo "Error running locomo_eval.py"
    exit 1
fi
echo "✅✅locomo judged files have been generated!"

echo "Running locomo_metric.py..."
python scripts/locomo/locomo_metric.py --lib $LIB
if [ $? -ne 0 ]; then
    echo "Error running locomo_metric.py"
    exit 1
fi
echo "✅✅✅Evaluation score have been generated!"
