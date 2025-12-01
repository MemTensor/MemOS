"""Example demonstrating SystemParser usage.

SystemParser handles system messages in chat conversations.
Note: System messages support multimodal content, but only text parts are allowed
(not file, image_url, or input_audio like user messages).
"""

import sys

from pathlib import Path

from dotenv import load_dotenv


try:
    from .print_utils import pretty_print_dict
except ImportError:
    # Fallback if print_utils is not available
    def pretty_print_dict(d):
        import json

        print(json.dumps(d, indent=2, ensure_ascii=False))


from memos.mem_reader.read_multi_modal.system_parser import SystemParser


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
    """Demonstrate SystemParser usage."""
    print("=== SystemParser Example ===\n")

    # 1. Initialize embedder and LLM (using shared config)
    embedder, llm = init_embedder_and_llm()

    # 3. Create SystemParser
    parser = SystemParser(embedder=embedder, llm=llm)

    # 4. Example system messages (simple text)
    simple_system_message = {
        "role": "system",
        "content": "You are a helpful assistant that provides clear and concise answers.",
        "chat_time": "2025-01-15T10:00:00",
        "message_id": "msg_001",
    }

    print("📝 Example 1: Simple text system message\n")
    pretty_print_dict(simple_system_message)

    info = {"user_id": "user1", "session_id": "session1"}
    source = parser.create_source(simple_system_message, info)

    print("  ✅ Created SourceMessage:")
    print(f"     - Type: {source.type}")
    print(f"     - Role: {source.role}")
    print(f"     - Content: {source.content[:60]}...")
    print(f"     - Chat Time: {source.chat_time}")
    print(f"     - Message ID: {source.message_id}")
    print()

    # Parse in fast mode
    memory_items = parser.parse_fast(simple_system_message, info)
    print(f"  📊 Fast mode generated {len(memory_items)} memory item(s)")
    if memory_items:
        print(f"     - Memory: {memory_items[0].memory[:60]}...")
        print(f"     - Memory Type: {memory_items[0].metadata.memory_type}")
        print(f"     - Tags: {memory_items[0].metadata.tags}")
    print()

    # 5. Example multimodal system message (multiple text parts)
    # Note: System messages only support text parts, not file/image/audio
    multimodal_system_message = {
        "role": "system",
        "content": [
            {"type": "text", "text": "You are a helpful assistant."},
            {"type": "text", "text": "Always provide clear and concise answers."},
            {"type": "text", "text": "If you don't know something, say so."},
        ],
        "chat_time": "2025-01-15T10:05:00",
        "message_id": "msg_002",
    }

    print("📝 Example 2: Multimodal system message (multiple text parts)\n")
    pretty_print_dict(multimodal_system_message)
    print(f"Message contains {len(multimodal_system_message['content'])} text parts")

    sources = parser.create_source(multimodal_system_message, info)
    if isinstance(sources, list):
        print(f"  ✅ Created {len(sources)} SourceMessage(s):")
        for i, src in enumerate(sources, 1):
            print(f"     [{i}] Type: {src.type}, Role: {src.role}")
            print(f"         Content: {src.content[:50]}...")
    else:
        print(f"  ✅ Created SourceMessage: Type={sources.type}")
    print()

    # Parse in fast mode
    memory_items = parser.parse_fast(multimodal_system_message, info)
    print(f"  📊 Fast mode generated {len(memory_items)} memory item(s)")
    if memory_items:
        print(f"     - Memory: {memory_items[0].memory[:60]}...")
        print(f"     - Memory Type: {memory_items[0].metadata.memory_type}")
        print(f"     - Tags: {memory_items[0].metadata.tags}")
        # Show sources from memory item
        if memory_items[0].metadata.sources:
            print(f"     - Sources: {len(memory_items[0].metadata.sources)} SourceMessage(s)")
    print()

    # 6. Example with structured system instructions
    structured_system_message = {
        "role": "system",
        "content": [
            {
                "type": "text",
                "text": "You are a coding assistant specialized in Python programming.",
            },
            {"type": "text", "text": "Always write clean, well-documented code."},
            {"type": "text", "text": "Explain your reasoning when providing solutions."},
        ],
        "chat_time": "2025-01-15T10:10:00",
        "message_id": "msg_003",
    }

    print("📝 Example 3: Structured system instructions (multiple text parts)\n")
    pretty_print_dict(structured_system_message)

    sources = parser.create_source(structured_system_message, info)
    if isinstance(sources, list):
        print(f"  ✅ Created {len(sources)} SourceMessage(s):")
        for i, src in enumerate(sources, 1):
            print(f"     [{i}] Type: {src.type}, Role: {src.role}")
            print(f"         Content: {src.content[:50]}...")
    print()

    # Rebuild examples
    print("🔄 Rebuilding messages from sources:\n")
    if isinstance(sources, list) and sources:
        rebuilt = parser.rebuild_from_source(sources[0])
    else:
        rebuilt = parser.rebuild_from_source(source)
    if rebuilt:
        pretty_print_dict(rebuilt)
    print("✅ SystemParser example completed!")


if __name__ == "__main__":
    main()
