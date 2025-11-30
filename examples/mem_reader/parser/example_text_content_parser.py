"""Example demonstrating TextContentParser usage.

TextContentParser handles text content parts in multimodal messages (RawMessageList).
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.mem_reader.read_multi_modal.text_content_parser import TextContentParser


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
    """Demonstrate TextContentParser usage."""
    print("=== TextContentParser Example ===\n")

    # 1. Initialize embedder and LLM (using shared config)
    embedder, llm = init_embedder_and_llm()

    # 3. Create TextContentParser
    parser = TextContentParser(embedder=embedder, llm=llm)

    # 4. Example text content parts
    text_content_parts = [
        {"type": "text", "text": "This is a simple text content part."},
        {"type": "text", "text": "TextContentParser handles text parts in multimodal messages."},
        {
            "type": "text",
            "text": "This parser is used when processing RawMessageList items that contain text content.",
        },
    ]

    print("📝 Processing text content parts:\n")
    for i, part in enumerate(text_content_parts, 1):
        print(f"Text Content Part {i}:")
        print(f"  Text: {part['text'][:60]}...")

        # Create source from text content part
        info = {"user_id": "user1", "session_id": "session1"}
        source = parser.create_source(part, info)

        print("  ✅ Created SourceMessage:")
        print(f"     - Type: {source.type}")
        print(f"     - Content: {source.content[:60]}...")
        if hasattr(source, "original_part") and source.original_part:
            print("     - Has original_part: Yes")
        print()

        # Rebuild text content part from source
        rebuilt = parser.rebuild_from_source(source)
        print(f"  🔄 Rebuilt part: type={rebuilt['type']}, text={rebuilt['text'][:40]}...")
        print()

    print("✅ TextContentParser example completed!")


if __name__ == "__main__":
    main()
