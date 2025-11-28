"""Example demonstrating UserParser usage.

UserParser handles user messages, including multimodal messages with text, files, images, etc.
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.mem_reader.read_multi_model.user_parser import UserParser


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
    """Demonstrate UserParser usage."""
    print("=== UserParser Example ===\n")

    # 1. Initialize embedder and LLM (using shared config)
    embedder, llm = init_embedder_and_llm()

    # 3. Create UserParser
    parser = UserParser(embedder=embedder, llm=llm)

    # 4. Example user messages (simple text)
    simple_user_message = {
        "role": "user",
        "content": "I'm feeling a bit down today. Can you help me?",
        "chat_time": "2025-01-15T10:00:00",
        "message_id": "msg_001",
    }

    print("📝 Example 1: Simple text user message\n")
    print(f"Message: {simple_user_message['content']}")

    info = {"user_id": "user1", "session_id": "session1"}
    source = parser.create_source(simple_user_message, info)

    print("  ✅ Created SourceMessage:")
    print(f"     - Type: {source.type}")
    print(f"     - Role: {source.role}")
    print(f"     - Content: {source.content[:60]}...")
    print()

    # Parse in fast mode
    memory_items = parser.parse_fast(simple_user_message, info)
    print(f"  📊 Fast mode generated {len(memory_items)} memory item(s)")
    if memory_items:
        print(f"     - Memory: {memory_items[0].memory[:60]}...")
        print(f"     - Memory Type: {memory_items[0].metadata.memory_type}")
    print()

    # 5. Example multimodal user message (text + file)
    multimodal_user_message = {
        "role": "user",
        "content": [
            {"type": "text", "text": "Please analyze this document:"},
            {
                "type": "file",
                "file": {
                    "filename": "report.pdf",
                    "file_id": "file_123",
                    "file_data": "This is the content of the PDF file...",
                },
            },
        ],
        "chat_time": "2025-01-15T10:05:00",
        "message_id": "msg_002",
    }

    print("📝 Example 2: Multimodal user message (text + file)\n")
    print(f"Message contains {len(multimodal_user_message['content'])} parts")

    sources = parser.create_source(multimodal_user_message, info)
    if isinstance(sources, list):
        print(f"  ✅ Created {len(sources)} SourceMessage(s):")
        for i, src in enumerate(sources, 1):
            print(f"     [{i}] Type: {src.type}, Role: {src.role}")
            if src.type == "text":
                print(f"         Content: {src.content[:50]}...")
            elif src.type == "file":
                print(f"         Doc Path: {src.doc_path}")
    else:
        print(f"  ✅ Created SourceMessage: Type={sources.type}")

    # Parse in fast mode
    memory_items = parser.parse_fast(multimodal_user_message, info)
    print(f"  📊 Fast mode generated {len(memory_items)} memory item(s)")
    print()

    # 6. Example with image_url (future support)
    image_user_message = {
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {
                "type": "image_url",
                "image_url": {"url": "https://example.com/image.jpg"},
            },
        ],
        "chat_time": "2025-01-15T10:10:00",
        "message_id": "msg_003",
    }

    print("📝 Example 3: User message with image\n")
    sources = parser.create_source(image_user_message, info)
    if isinstance(sources, list):
        print(f"  ✅ Created {len(sources)} SourceMessage(s):")
        for i, src in enumerate(sources, 1):
            print(f"     [{i}] Type: {src.type}, Role: {src.role}")
    print()

    # Rebuild examples
    print("🔄 Rebuilding messages from sources:\n")
    rebuilt_simple = parser.rebuild_from_source(source)
    print(
        f"  Simple message: role={rebuilt_simple['role']}, content={rebuilt_simple['content'][:40]}..."
    )

    if isinstance(sources, list) and len(sources) > 0:
        rebuilt_multimodal = parser.rebuild_from_source(sources[0])
        print(f"  Multimodal message (first part): role={rebuilt_multimodal['role']}")
    print()

    print("✅ UserParser example completed!")


if __name__ == "__main__":
    main()
