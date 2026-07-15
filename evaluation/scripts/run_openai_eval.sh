#!/bin/bash

# Common parameters for all scripts
LIB="openai"
VERSION="default"
WORKERS=10
NUM_RUNS=3


echo "Running locomo_openai.py..."
python scripts/locomo/locomo_openai.py --version $VERSION
if [ $? -ne 0 ]; then
    echo "Error running locomo_openai.py."
    exit 1
fi

echo "Running locomo_eval.py..."
python scripts/locomo/locomo_eval.py --lib $LIB --version $VERSION --num_runs $NUM_RUNS
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
