"""Example demonstrating SystemParser usage.

SystemParser handles system messages in chat conversations.
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.mem_reader.read_multi_model.system_parser import SystemParser


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

    # 4. Example system messages
    system_messages = [
        {
            "role": "system",
            "content": "You are a helpful assistant that provides clear and concise answers.",
            "chat_time": "2025-01-15T10:00:00",
            "message_id": "msg_001",
        },
        {
            "role": "system",
            "content": "You are a coding assistant specialized in Python programming.",
            "chat_time": "2025-01-15T10:05:00",
            "message_id": "msg_002",
        },
    ]

    print("📝 Processing system messages:\n")
    for i, message in enumerate(system_messages, 1):
        print(f"System Message {i}:")
        print(f"  Content: {message['content']}")

        # Create source from system message
        info = {"user_id": "user1", "session_id": "session1"}
        source = parser.create_source(message, info)

        print("  ✅ Created SourceMessage:")
        print(f"     - Type: {source.type}")
        print(f"     - Role: {source.role}")
        print(f"     - Content: {source.content[:60]}...")
        print(f"     - Chat Time: {source.chat_time}")
        print(f"     - Message ID: {source.message_id}")
        print()

        # Parse in fast mode
        memory_items = parser.parse_fast(message, info)
        print(f"  📊 Fast mode generated {len(memory_items)} memory item(s)")
        if memory_items:
            print(f"     - Memory: {memory_items[0].memory[:60]}...")
            print(f"     - Memory Type: {memory_items[0].metadata.memory_type}")
            print(f"     - Tags: {memory_items[0].metadata.tags}")
        print()

        # Rebuild system message from source
        rebuilt = parser.rebuild_from_source(source)
        print(f"  🔄 Rebuilt message: role={rebuilt['role']}, content={rebuilt['content'][:40]}...")
        print()

    print("✅ SystemParser example completed!")


if __name__ == "__main__":
    main()
