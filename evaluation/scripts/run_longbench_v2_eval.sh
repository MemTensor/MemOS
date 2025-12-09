#!/bin/bash

# Common parameters for all scripts
LIB="memos-api"
VERSION="long-bench-v2-1208-1556-async"
WORKERS=10
TOPK=20
MAX_SAMPLES=""  # Empty means all samples
WAIT_INTERVAL=2   # seconds between polls
WAIT_TIMEOUT=900  # seconds per user

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --lib)
            LIB="$2"
            shift 2
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --workers)
            WORKERS="$2"
            shift 2
            ;;
        --top_k)
            TOPK="$2"
            shift 2
            ;;
        --max_samples)
            MAX_SAMPLES="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Build max_samples argument
MAX_SAMPLES_ARG=""
if [ -n "$MAX_SAMPLES" ]; then
    MAX_SAMPLES_ARG="--max_samples $MAX_SAMPLES"
fi

echo "Running LongBench v2 evaluation with:"
echo "  LIB: $LIB"
echo "  VERSION: $VERSION"
echo "  WORKERS: $WORKERS"
echo "  TOPK: $TOPK"
echo "  MAX_SAMPLES: ${MAX_SAMPLES:-all}"
echo ""

# Step 2: Search
echo ""
echo "=========================================="
echo "Step 2: Running longbench_v2_search.py..."
echo "=========================================="
python scripts/long_bench-v2/longbench_v2_search.py \
    --lib $LIB \
    --version $VERSION \
    --top_k $TOPK \
    --workers $WORKERS \
    $MAX_SAMPLES_ARG

if [ $? -ne 0 ]; then
    echo "Error running longbench_v2_search.py"
    exit 1
fi

# Step 3: Response Generation
echo ""
echo "=========================================="
echo "Step 3: Running longbench_v2_responses.py..."
echo "=========================================="
python scripts/long_bench-v2/longbench_v2_responses.py \
    --lib $LIB \
    --version $VERSION \
    --workers $WORKERS

if [ $? -ne 0 ]; then
    echo "Error running longbench_v2_responses.py"
    exit 1
fi

# Step 4: Metrics Calculation
echo ""
echo "=========================================="
echo "Step 4: Running longbench_v2_metric.py..."
echo "=========================================="
python scripts/long_bench-v2/longbench_v2_metric.py \
    --lib $LIB \
    --version $VERSION

if [ $? -ne 0 ]; then
    echo "Error running longbench_v2_metric.py"
    exit 1
fi

echo ""
echo "=========================================="
echo "All steps completed successfully!"
echo "=========================================="
echo ""
echo "Results are saved in: results/long_bench-v2/$LIB-$VERSION/"
echo "  - Search results: ${LIB}_longbench_v2_search_results.json"
echo "  - Responses: ${LIB}_longbench_v2_responses.json"
echo "  - Metrics: ${LIB}_longbench_v2_metrics.json"
