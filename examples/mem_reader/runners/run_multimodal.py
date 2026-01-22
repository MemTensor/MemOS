"""Runner for MultiModalStructMemReader."""

import argparse
import json
import time
import traceback

from examples.mem_reader.builders import build_multimodal_reader
from examples.mem_reader.samples import (
    MULTIMODAL_MESSAGE_CASES,
    RAW_INPUT_CASES,
    STRING_MESSAGE_CASES,
)
from examples.mem_reader.utils import print_memory_item


# Map example names to test cases
EXAMPLE_MAP = {
    "string_message": STRING_MESSAGE_CASES,
    "multimodal": MULTIMODAL_MESSAGE_CASES,
    "raw_input": RAW_INPUT_CASES,
}


def run_multimodal_reader():
    """Run MultiModalStructMemReader with sample data."""
    parser = argparse.ArgumentParser(description="MultiModalStructMemReader Example")
    parser.add_argument(
        "--example",
        type=str,
        default="all",
        choices=[*list(EXAMPLE_MAP.keys()), "all"],
        help="Example to run",
    )
    parser.add_argument(
        "--mode",
        type=str,
        default="fine",
        choices=["fast", "fine"],
        help="Processing mode (fast/fine)",
    )
    parser.add_argument(
        "--format",
        type=str,
        default="text",
        choices=["text", "json"],
        help="Output format",
    )

    args = parser.parse_args()

    print("🚀 Initializing MultiModalStructMemReader...")
    reader = build_multimodal_reader()
    print("✅ Initialization complete.")

    # Select test cases
    if args.example == "all":
        test_cases = []
        for cases in EXAMPLE_MAP.values():
            test_cases.extend(cases)
    else:
        test_cases = EXAMPLE_MAP[args.example]

    print(f"📋 Running {len(test_cases)} test cases in '{args.mode}' mode...\n")

    results = []

    for i, case in enumerate(test_cases):
        print(f"🔹 Case {i + 1}: {case.name} - {case.description}")

        info = case.get_info()
        scene_data = case.scene_data

        # Data structure adaptation logic
        # Ensure scene_data is List[List[dict]] if it looks like a single conversation
        # Most samples in samples.py are wrapped in [], so they are List[List[dict]].
        # Except STRING_MESSAGE_CASES which are List[str].
        if (
            isinstance(scene_data, list)
            and len(scene_data) > 0
            and not isinstance(scene_data[0], list)
            and not isinstance(scene_data[0], str)
        ):
            scene_data = [scene_data]

        try:
            start_time = time.time()

            # Determine input type
            input_type = "chat"
            if case in EXAMPLE_MAP["string_message"]:
                input_type = "string"
            elif case in EXAMPLE_MAP["raw_input"]:
                input_type = "raw"

            memories = reader.get_memory(
                scene_data,
                type=input_type,
                mode=args.mode,
                info=info,
            )
            duration = time.time() - start_time

            result_entry = {
                "case": case.name,
                "description": case.description,
                "duration_seconds": round(duration, 4),
                "memory_count": sum(len(m) for m in memories),
                "memories": [],
            }

            print(
                f"   ✅ Processed in {duration:.4f}s. Extracted {result_entry['memory_count']} memories."
            )

            # Flatten memories for display/output
            flat_memories = [item for sublist in memories for item in sublist]

            if args.format == "json":
                # Convert TextualMemoryItem to dict
                result_entry["memories"] = [
                    m.to_dict() if hasattr(m, "to_dict") else str(m) for m in flat_memories
                ]
                results.append(result_entry)
            else:
                for item in flat_memories:
                    print_memory_item(item, indent=6)
                print()

        except Exception as e:
            print(f"   ❌ Error: {e}")
            traceback.print_exc()

    if args.format == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    run_multimodal_reader()
