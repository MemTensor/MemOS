"""Example demonstrating ToolParser usage.

ToolParser handles tool/function call messages in chat conversations.
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.mem_reader.read_multi_modal.tool_parser import ToolParser


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
    """Demonstrate ToolParser usage."""
    print("=== ToolParser Example ===\n")

    # 1. Initialize embedder and LLM (using shared config)
    embedder, llm = init_embedder_and_llm()

    # 3. Create ToolParser
    parser = ToolParser(embedder=embedder, llm=llm)

    # 4. Example tool messages
    tool_messages = [
        {
            "role": "tool",
            "content": '{"result": "Weather in New York: 72°F, sunny"}',
            "tool_call_id": "call_abc123",
            "chat_time": "2025-01-15T10:00:30",
            "message_id": "msg_001",
        },
        {
            "role": "tool",
            "content": '{"status": "success", "data": {"items": [1, 2, 3]}}',
            "tool_call_id": "call_def456",
            "chat_time": "2025-01-15T10:05:30",
            "message_id": "msg_002",
        },
        {
            "role": "tool",
            "content": "Database query executed successfully. Retrieved 5 records.",
            "tool_call_id": "call_ghi789",
            "chat_time": "2025-01-15T10:10:30",
            "message_id": "msg_003",
        },
    ]

    print("📝 Processing tool messages:\n")
    for i, message in enumerate(tool_messages, 1):
        print(f"Tool Message {i}:")
        print(f"  Content: {message['content'][:60]}...")
        print(f"  Tool Call ID: {message['tool_call_id']}")

        # Create source from tool message
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

        # Rebuild tool message from source
        rebuilt = parser.rebuild_from_source(source)
        print("  🔄 Rebuilt message:")
        print(f"     - Role: {rebuilt['role']}")
        print(f"     - Tool Call ID: {rebuilt.get('tool_call_id', 'N/A')}")
        print(f"     - Content: {rebuilt['content'][:40]}...")
        print()

    print("✅ ToolParser example completed!")


if __name__ == "__main__":
    main()
