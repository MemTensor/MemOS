#!/usr/bin/env python3
"""
Test script for memory processing functionality in eval_analyzer.py

This script demonstrates how to use the new LLM memory processing features
to analyze and improve memory-based question answering.
"""

import json
import os
import sys

from pathlib import Path
from typing import Any

from memos.log import get_logger
from memos.mem_scheduler.analyzer.eval_analyzer import EvalAnalyzer


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent  # Go up to project root
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


logger = get_logger(__name__)


def create_sample_bad_cases() -> list[dict[str, Any]]:
    """Create sample bad cases for testing memory processing."""
    return [
        {
            "query": "What is the capital of France?",
            "golden_answer": "Paris",
            "memories": """
            Memory 1: France is a country in Western Europe.
            Memory 2: The Eiffel Tower is located in Paris.
            Memory 3: Paris is known for its art museums and fashion.
            Memory 4: French cuisine is famous worldwide.
            Memory 5: The Seine River flows through Paris.
            """,
        },
        {
            "query": "When was the iPhone first released?",
            "golden_answer": "June 29, 2007",
            "memories": """
            Memory 1: Apple Inc. was founded by Steve Jobs, Steve Wozniak, and Ronald Wayne.
            Memory 2: The iPhone was announced by Steve Jobs at the Macworld Conference & Expo on January 9, 2007.
            Memory 3: The iPhone went on sale on June 29, 2007.
            Memory 4: The original iPhone had a 3.5-inch screen.
            Memory 5: Apple's stock price increased significantly after the iPhone launch.
            """,
        },
        {
            "query": "What is photosynthesis?",
            "golden_answer": "Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce glucose and oxygen.",
            "memories": """
            Memory 1: Plants are living organisms that need sunlight to grow.
            Memory 2: Chlorophyll is the green pigment in plants.
            Memory 3: Plants take in carbon dioxide from the air.
            Memory 4: Water is absorbed by plant roots from the soil.
            Memory 5: Oxygen is released by plants during the day.
            Memory 6: Glucose is a type of sugar that plants produce.
            """,
        },
    ]


def memory_processing(bad_cases):
    """
    Test the memory processing functionality with cover rate and acc rate analysis.

    This function analyzes:
    1. Cover rate: Whether memories contain all information needed to answer the query
    2. Acc rate: Whether processed memories can correctly answer the query
    """
    print("🧪 Testing Memory Processing Functionality with Cover Rate & Acc Rate Analysis")
    print("=" * 80)

    # Initialize analyzer
    analyzer = EvalAnalyzer()

    print(f"📊 Testing with {len(bad_cases)} sample cases")
    print()

    # Initialize counters for real-time statistics
    total_cases = 0
    cover_count = 0  # Cases where memories cover all needed information
    acc_count = 0  # Cases where processed memories can correctly answer

    # Process each case
    for i, case in enumerate(bad_cases):
        total_cases += 1

        # Safely handle query display
        query_display = str(case.get("query", "Unknown query"))
        print(f"🔍 Case {i + 1}/{len(bad_cases)}: {query_display}...")

        # Safely handle golden_answer display (convert to string if needed)
        golden_answer = case.get("golden_answer", "Unknown answer")
        golden_answer_str = str(golden_answer) if golden_answer is not None else "Unknown answer"
        print(f"📝 Golden Answer: {golden_answer_str}")
        print()

        # Step 1: Analyze if memories contain sufficient information (Cover Rate)
        print("  📋 Step 1: Analyzing memory coverage...")
        coverage_analysis = analyzer.analyze_memory_sufficiency(
            case["query"],
            golden_answer_str,  # Use the string version
            case["memories"],
        )

        has_coverage = coverage_analysis.get("sufficient", False)
        if has_coverage:
            cover_count += 1

        print(f"    ✅ Memory Coverage: {'SUFFICIENT' if has_coverage else 'INSUFFICIENT'}")
        print(f"    🎯 Confidence: {coverage_analysis.get('confidence', 0):.2f}")
        print(f"    💭 Reasoning: {coverage_analysis.get('reasoning', 'N/A')}...")
        if not has_coverage:
            print(
                f"    ❌ Missing Info: {coverage_analysis.get('missing_information', 'N/A')[:100]}..."
            )
            continue
        print()

        # Step 2: Process memories and test answer ability (Acc Rate)
        print("  🔄 Step 2: Processing memories and testing answer ability...")

        processing_result = analyzer.scheduler_mem_process(
            query=case["query"],
            memories=case["memories"],
        )
        print(f"Original Memories: {case['memories']}")
        print(f"Processed Memories: {processing_result['processed_memories']}")
        print(f"    📏 Compression ratio: {processing_result['compression_ratio']:.2f}")
        print(f"    📄 Processed memories length: {processing_result['processed_length']} chars")

        # Generate answer with processed memories
        answer_result = analyzer.generate_answer_with_memories(
            case["query"], processing_result["processed_memories"], "processed_enhanced"
        )

        # Evaluate if the generated answer is correct
        print("  🎯 Step 3: Evaluating answer correctness...")
        answer_evaluation = analyzer.compare_answer_quality(
            case["query"],
            golden_answer_str,  # Use the string version
            "No original answer available",  # We don't have original answer
            answer_result["answer"],
        )

        # Determine if processed memories can correctly answer (simplified logic)
        processed_accuracy = answer_evaluation.get("processed_scores", {}).get("accuracy", 0)
        can_answer_correctly = processed_accuracy >= 0.7  # Threshold for "correct" answer

        if can_answer_correctly:
            acc_count += 1

        print(f"    💬 Generated Answer: {answer_result['answer']}...")
        print(
            f"    ✅ Answer Accuracy: {'CORRECT' if can_answer_correctly else 'INCORRECT'} (score: {processed_accuracy:.2f})"
        )
        print()

        # Calculate and print real-time rates
        current_cover_rate = cover_count / total_cases
        current_acc_rate = acc_count / total_cases

        print("  📊 REAL-TIME STATISTICS:")
        print(f"    🎯 Cover Rate: {current_cover_rate:.2%} ({cover_count}/{total_cases})")
        print(f"    ✅ Acc Rate: {current_acc_rate:.2%} ({acc_count}/{total_cases})")
        print()

        print("-" * 80)
        print()

    # Final summary
    print("🏁 FINAL ANALYSIS SUMMARY")
    print("=" * 80)
    print(f"📊 Total Cases Processed: {total_cases}")
    print(f"🎯 Final Cover Rate: {cover_count / total_cases:.2%} ({cover_count}/{total_cases})")
    print(f"   - Cases with sufficient memory coverage: {cover_count}")
    print(f"   - Cases with insufficient memory coverage: {total_cases - cover_count}")
    print()
    print(f"✅ Final Acc Rate: {acc_count / total_cases:.2%} ({acc_count}/{total_cases})")
    print(f"   - Cases where processed memories can answer correctly: {acc_count}")
    print(f"   - Cases where processed memories cannot answer correctly: {total_cases - acc_count}")
    print()

    # Additional insights
    if cover_count > 0:
        effective_processing_rate = acc_count / cover_count if cover_count > 0 else 0
        print(f"🔄 Processing Effectiveness: {effective_processing_rate:.2%}")
        print(
            f"   - Among cases with sufficient coverage, {effective_processing_rate:.1%} can be answered correctly after processing"
        )

    print("=" * 80)


def load_real_bad_cases(file_path: str) -> list[dict[str, Any]]:
    """Load real bad cases from JSON file."""
    print(f"📂 Loading bad cases from: {file_path}")

    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)

    bad_cases = data.get("bad_cases", [])
    print(f"✅ Loaded {len(bad_cases)} bad cases")

    return bad_cases


def main():
    """Main test function."""
    print("🚀 Memory Processing Test Suite")
    print("=" * 60)
    print()

    # Check if OpenAI API key is set
    if not os.getenv("OPENAI_API_KEY"):
        print("⚠️  Warning: OPENAI_API_KEY not found in environment variables")
        print("   Please set your OpenAI API key to run the tests")
        return

    try:
        bad_cases_file = f"{BASE_DIR}/tmp/eval_analyzer/bad_cases_extraction_only.json"
        bad_cases = load_real_bad_cases(bad_cases_file)

        print(f"✅ Created {len(bad_cases)} sample bad cases")
        print()

        # Run memory processing tests
        memory_processing(bad_cases)

        print("✅ All tests completed successfully!")

    except Exception as e:
        print(f"❌ Test failed with error: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    main()
