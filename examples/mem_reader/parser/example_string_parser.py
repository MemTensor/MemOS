"""Example demonstrating StringParser usage.

StringParser handles simple string messages that need to be converted to memory items.
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.mem_reader.read_multi_modal.string_parser import StringParser


# Handle imports for both script and module usage
try:
    from .config_utils import init_embedder_and_llm
except ImportError:
    # When running as script, add parent directory to path
    sys.path.insert(0, str(Path(__file__).parent))
    from config_utils import init_embedder_and_llm

# Load environment variables
load_dotenv()


def main():
    """Demonstrate StringParser usage."""
    print("=== StringParser Example ===\n")

    # 1. Initialize embedder and LLM (using shared config)
    embedder, llm = init_embedder_and_llm()

    # 3. Create StringParser
    parser = StringParser(embedder=embedder, llm=llm)

    # 4. Example string messages
    string_messages = [
        "This is a simple text message that needs to be parsed.",
        "Another string message for processing.",
        "StringParser handles plain text strings and converts them to SourceMessage objects.",
    ]

    print("📝 Processing string messages:\n")
    for i, message in enumerate(string_messages, 1):
        print(f"Message {i}: {message[:50]}...")

        # Create source from string
        info = {"user_id": "user1", "session_id": "session1"}
        source = parser.create_source(message, info)

        print("  ✅ Created SourceMessage:")
        print(f"     - Type: {source.type}")
        print(f"     - Content: {source.content[:50]}...")
        print()

        # Rebuild string from source
        rebuilt = parser.rebuild_from_source(source)
        print(f"  🔄 Rebuilt string: {rebuilt[:50]}...")
        print()

    print("✅ StringParser example completed!")


if __name__ == "__main__":
    main()
