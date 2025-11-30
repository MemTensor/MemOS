"""Example demonstrating FileContentParser usage.

FileContentParser handles file content parts in multimodal messages (RawMessageList).
"""

import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.configs.parser import ParserConfigFactory
from memos.mem_reader.read_multi_modal.file_content_parser import FileContentParser
from memos.parsers.factory import ParserFactory


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
    """Demonstrate FileContentParser usage."""
    print("=== FileContentParser Example ===\n")

    # 1. Initialize embedder and LLM (using shared config)
    embedder, llm = init_embedder_and_llm()

    # 3. Initialize parser for file content parsing (optional)
    try:
        parser_config = ParserConfigFactory.model_validate(
            {
                "backend": "markitdown",
                "config": {},
            }
        )
        file_parser = ParserFactory.from_config(parser_config)
    except Exception as e:
        print(f"⚠️  Warning: Could not initialize file parser: {e}")
        print("   FileContentParser will work without a parser, but file parsing will be limited.")
        file_parser = None

    # 4. Create FileContentParser
    parser = FileContentParser(embedder=embedder, llm=llm, parser=file_parser)

    # 5. Example file content parts
    file_content_parts = [
        {
            "type": "file",
            "file": {
                "filename": "document.pdf",
                "file_id": "file_123",
                "file_data": "This is the content extracted from the PDF file...",
            },
        },
        {
            "type": "file",
            "file": {
                "filename": "report.docx",
                "file_id": "file_456",
                "file_data": "Report content: Analysis of Q4 performance...",
            },
        },
        {
            "type": "file",
            "file": {
                "filename": "data.csv",
                "file_id": "file_789",
                "path": "/path/to/data.csv",  # Alternative: using path instead of file_data
            },
        },
    ]

    print("📝 Processing file content parts:\n")
    for i, part in enumerate(file_content_parts, 1):
        print(f"File Content Part {i}:")
        file_info = part.get("file", {})
        print(f"  Filename: {file_info.get('filename', 'unknown')}")
        print(f"  File ID: {file_info.get('file_id', 'N/A')}")

        # Create source from file content part
        info = {"user_id": "user1", "session_id": "session1"}
        source = parser.create_source(part, info)

        print("  ✅ Created SourceMessage:")
        print(f"     - Type: {source.type}")
        print(f"     - Doc Path: {source.doc_path}")
        if source.content:
            print(f"     - Content: {source.content[:60]}...")
        if hasattr(source, "original_part") and source.original_part:
            print("     - Has original_part: Yes")
        print()

        # Rebuild file content part from source
        rebuilt = parser.rebuild_from_source(source)
        print("  🔄 Rebuilt part:")
        print(f"     - Type: {rebuilt['type']}")
        print(f"     - Filename: {rebuilt['file'].get('filename', 'N/A')}")
        print()

    # 6. Example with actual file path (if parser is available)
    if file_parser:
        print("📄 Testing file parsing with actual file path:\n")
        # Note: This is just an example - actual file parsing would require a real file
        example_file_part = {
            "type": "file",
            "file": {
                "filename": "example.txt",
                "path": "examples/mem_reader/text1.txt",  # Using existing test file
            },
        }

        try:
            source = parser.create_source(example_file_part, info)
            print(f"  ✅ Created SourceMessage for file: {source.doc_path}")
            # The parser would parse the file content if the file exists
        except Exception as e:
            print(f"  ⚠️  File parsing note: {e}")
        print()

    print("✅ FileContentParser example completed!")


if __name__ == "__main__":
    main()
