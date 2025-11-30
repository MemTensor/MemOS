"""Example demonstrating MultiModelParser parser selection.

This example verifies that different input types correctly return
the corresponding parser instances.
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.mem_reader.read_multi_model.multi_model_parser import MultiModelParser


# Add src directory to path for imports
project_root = Path(__file__).parent.parent.parent.parent
src_path = project_root / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))


# Handle imports for both script and module usage
try:
    from .config_utils import init_embedder_and_llm
except ImportError:
    # When running as script, add parent directory to path
    sys.path.insert(0, str(Path(__file__).parent))
    from config_utils import init_embedder_and_llm

# Load environment variables
load_dotenv()


def parser_selection():
    """Test that different input types return the correct parser."""
    print("=== MultiModelParser Parser Selection Test ===\n")

    # 1. Initialize embedder and LLM
    embedder, llm = init_embedder_and_llm()

    # 2. Create MultiModelParser
    parser = MultiModelParser(embedder=embedder, llm=llm)

    # 3. Test cases: different input types
    test_cases = [
        # String input -> StringParser
        {
            "name": "String input",
            "message": "This is a simple string message",
            "expected_parser_type": "StringParser",
        },
        # RawMessageList: text type -> TextContentParser
        {
            "name": "Text content part (RawMessageList)",
            "message": {"type": "text", "text": "This is a text content part"},
            "expected_parser_type": "TextContentParser",
        },
        # RawMessageList: file type -> FileContentParser
        {
            "name": "File content part (RawMessageList)",
            "message": {
                "type": "file",
                "file": {
                    "filename": "example.pdf",
                    "file_data": "File content here",
                },
            },
            "expected_parser_type": "FileContentParser",
        },
        # MessageList: system role -> SystemParser
        {
            "name": "System message",
            "message": {
                "role": "system",
                "content": "You are a helpful assistant.",
            },
            "expected_parser_type": "SystemParser",
        },
        # MessageList: user role -> UserParser
        {
            "name": "User message (simple)",
            "message": {
                "role": "user",
                "content": "Hello, how are you?",
            },
            "expected_parser_type": "UserParser",
        },
        # MessageList: user role with multimodal content -> UserParser
        {
            "name": "User message (multimodal)",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What's in this image?"},
                    {"type": "file", "file": {"filename": "image.jpg", "file_data": ""}},
                ],
            },
            "expected_parser_type": "UserParser",
        },
        # MessageList: assistant role -> AssistantParser
        {
            "name": "Assistant message",
            "message": {
                "role": "assistant",
                "content": "I'm doing well, thank you!",
            },
            "expected_parser_type": "AssistantParser",
        },
        # MessageList: tool role -> ToolParser
        {
            "name": "Tool message",
            "message": {
                "role": "tool",
                "content": "Tool execution result",
                "tool_call_id": "call_123",
            },
            "expected_parser_type": "ToolParser",
        },
    ]

    print("Testing parser selection for different input types:\n")
    all_passed = True

    for i, test_case in enumerate(test_cases, 1):
        message = test_case["message"]
        expected_type = test_case["expected_parser_type"]
        test_name = test_case["name"]

        # Get parser using internal method
        selected_parser = parser._get_parser(message)

        # Check if parser was found
        if selected_parser is None:
            print(f"❌ Test {i}: {test_name}")
            print(f"   Expected: {expected_type}")
            print("   Got: None (parser not found)")
            print(f"   Message: {message}\n")
            all_passed = False
            continue

        # Get actual parser type name
        actual_type = type(selected_parser).__name__

        # Verify parser type
        if actual_type == expected_type:
            print(f"✅ Test {i}: {test_name}")
            print(f"   Expected: {expected_type}")
            print(f"   Got: {actual_type}")
            print(f"   Parser instance: {selected_parser}")
        else:
            print(f"❌ Test {i}: {test_name}")
            print(f"   Expected: {expected_type}")
            print(f"   Got: {actual_type}")
            print(f"   Message: {message}")
            all_passed = False
        print()

    # Test edge cases
    print("\n=== Testing Edge Cases ===\n")

    edge_cases = [
        {
            "name": "Unknown message type (not dict, not str)",
            "message": 12345,
            "should_return_none": True,
        },
        {
            "name": "Dict without type or role",
            "message": {"content": "Some content"},
            "should_return_none": True,
        },
        {
            "name": "Unknown type in RawMessageList",
            "message": {"type": "unknown_type", "data": "some data"},
            "should_return_none": True,
        },
        {
            "name": "Unknown role in MessageList",
            "message": {"role": "unknown_role", "content": "some content"},
            "should_return_none": True,
        },
        {
            "name": "List of messages (not handled by _get_parser)",
            "message": [
                {"role": "user", "content": "Message 1"},
                {"role": "assistant", "content": "Message 2"},
            ],
            "should_return_none": True,  # Lists are handled in parse(), not _get_parser()
        },
    ]

    for i, test_case in enumerate(edge_cases, 1):
        message = test_case["message"]
        should_return_none = test_case["should_return_none"]
        test_name = test_case["name"]

        selected_parser = parser._get_parser(message)

        if should_return_none:
            if selected_parser is None:
                print(f"✅ Edge Case {i}: {test_name}")
                print("   Correctly returned None")
            else:
                print(f"❌ Edge Case {i}: {test_name}")
                print("   Expected: None")
                print(f"   Got: {type(selected_parser).__name__}")
                all_passed = False
        else:
            if selected_parser is not None:
                print(f"✅ Edge Case {i}: {test_name}")
                print(f"   Got parser: {type(selected_parser).__name__}")
            else:
                print(f"❌ Edge Case {i}: {test_name}")
                print("   Expected: Parser")
                print("   Got: None")
                all_passed = False
        print()

    # Summary
    print("=" * 60)
    if all_passed:
        print("✅ All tests passed! Parser selection is working correctly.")
    else:
        print("❌ Some tests failed. Please check the output above.")
    print("=" * 60)


def parser_instances():
    """Test that parser instances are correctly initialized."""
    print("\n=== Parser Instance Verification ===\n")

    embedder, llm = init_embedder_and_llm()
    parser = MultiModelParser(embedder=embedder, llm=llm)

    # Verify all parser instances are initialized
    parsers_to_check = {
        "string_parser": "StringParser",
        "system_parser": "SystemParser",
        "user_parser": "UserParser",
        "assistant_parser": "AssistantParser",
        "tool_parser": "ToolParser",
        "text_content_parser": "TextContentParser",
        "file_content_parser": "FileContentParser",
    }

    print("Checking parser instance initialization:\n")
    all_initialized = True

    for attr_name, expected_type in parsers_to_check.items():
        parser_instance = getattr(parser, attr_name, None)
        if parser_instance is None:
            print(f"❌ {attr_name}: Not initialized")
            all_initialized = False
        else:
            actual_type = type(parser_instance).__name__
            if actual_type == expected_type:
                print(f"✅ {attr_name}: {actual_type}")
            else:
                print(f"❌ {attr_name}: Expected {expected_type}, got {actual_type}")
                all_initialized = False

    print()
    if all_initialized:
        print("✅ All parser instances are correctly initialized!")
    else:
        print("❌ Some parser instances are missing or incorrect.")
    print()


def main():
    """Run all tests."""
    parser_selection()
    parser_instances()
    print("\n✅ MultiModelParser example completed!")


if __name__ == "__main__":
    main()
