#!/bin/bash
LIB="rag"
VERSION="default"
DATA_SET="locomo"
CHUNK_SIZE=128
NUM_CHUNKS=1
export HF_ENDPOINT=https://hf-mirror.com
mkdir -p results/$DATA_SET/$LIB-$VERSION/
echo "The result saved in：results/$DATA_SET/$LIB-$VERSION/"

echo "The complete evaluation steps for generating the RAG and full context!"

echo "Running locomo_rag.py..."
python scripts/locomo/locomo_rag.py \
    --chunk_size $CHUNK_SIZE \
    --num_chunks $NUM_CHUNKS \
    --frame $LIB \
    --output_folder "results/$DATA_SET/$LIB-$VERSION/"

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

echo "Save the experimental results of this round..."
DIR="results/$DATA_SET/"
cd "$DIR" || { echo "Unable to enter directory $DIR"; exit 1; }

# Rename the folder to avoid being overwritten by new results
OLD_NAME="$LIB-$VERSION"
NEW_NAME="$LIB-$CHUNK_SIZE-$NUM_CHUNKS"

if [ -d "$OLD_NAME" ]; then
    # Rename the folder
    mv "$OLD_NAME" "$NEW_NAME"

    # Output prompt information
    echo "Already rename the folder: $OLD_NAME → $NEW_NAME"
else
    echo "Error:Folder $OLD_NAME is not exist"
    exit 1
fi
echo "✅✅✅✅ All the experiment has been successful..."
