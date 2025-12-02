"""Example demonstrating AssistantParser usage.

AssistantParser handles assistant messages in chat conversations.
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.mem_reader.read_multi_modal.assistant_parser import AssistantParser


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
    """Demonstrate AssistantParser usage."""
    print("=== AssistantParser Example ===\n")

    # 1. Initialize embedder and LLM (using shared config)
    embedder, llm = init_embedder_and_llm()

    # 3. Create AssistantParser
    parser = AssistantParser(embedder=embedder, llm=llm)

    # 4. Example assistant messages
    assistant_messages = [
        {
            "role": "assistant",
            "content": "I'm sorry to hear that you're feeling down. Would you like to talk about what's been going on?",
            "chat_time": "2025-01-15T10:00:30",
            "message_id": "msg_001",
        },
        {
            "role": "assistant",
            "content": "Based on the document you provided, I can see several key points: 1) The project timeline, 2) Budget considerations, and 3) Resource allocation.",
            "chat_time": "2025-01-15T10:05:30",
            "message_id": "msg_002",
        },
        {
            "role": "assistant",
            "content": "Here's a Python solution for your problem:\n```python\ndef solve_problem():\n    return 'solution'\n```",
            "chat_time": "2025-01-15T10:10:30",
            "message_id": "msg_003",
        },
    ]

    print("📝 Processing assistant messages:\n")
    for i, message in enumerate(assistant_messages, 1):
        print(f"Assistant Message {i}:")
        print(f"  Content: {message['content'][:60]}...")

        # Create source from assistant message
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

        # Rebuild assistant message from source
        rebuilt = parser.rebuild_from_source(source)
        print(f"  🔄 Rebuilt message: role={rebuilt['role']}, content={rebuilt['content'][:40]}...")
        print()

    print("✅ AssistantParser example completed!")


if __name__ == "__main__":
    main()
