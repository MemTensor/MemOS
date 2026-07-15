"""Demo for FileContentParser."""

from examples.mem_reader.builders import build_file_parser
from examples.mem_reader.samples import FILE_CONTENT_PARTS, FILE_CONTENT_REAL_FILE_PART
from memos.mem_reader.read_multi_modal.file_content_parser import FileContentParser

from ._base import BaseParserDemo


class FileContentParserDemo(BaseParserDemo):
    def create_parser(self):
        # Initialize the underlying file parser (MarkItDown)
        file_parser_impl = build_file_parser()

        return FileContentParser(
            embedder=self.embedder,
            llm=self.llm,
            parser=file_parser_impl,
        )

    def run(self):
        print("=== FileContentParser Demo ===")

        info = {"user_id": "user1", "session_id": "session1"}

        print("📝 Processing file content parts:\n")
        for i, part in enumerate(FILE_CONTENT_PARTS, 1):
            print(f"File Content Part {i}:")
            file_info = part.get("file", {})
            print(f"  Filename: {file_info.get('filename', 'unknown')}")
            print(f"  File ID: {file_info.get('file_id', 'N/A')}")

            # Create source from file content part
            source = self.parser.create_source(part, info)

            print("  ✅ Created SourceMessage:")
            print(f"     - Type: {source.type}")
            print(f"     - Doc Path: {source.doc_path}")
            if source.content:
                print(f"     - Content: {source.content[:60]}...")
            if hasattr(source, "original_part") and source.original_part:
                print("     - Has original_part: Yes")
            print()

            # Rebuild file content part from source
            rebuilt = self.parser.rebuild_from_source(source)
            print("  🔄 Rebuilt part:")
            print(f"     - Type: {rebuilt.get('type')}")
            print(f"     - Filename: {rebuilt.get('file', {}).get('filename', 'N/A')}")

            print()

        # 6. Example with actual file path (if parser is available)
        if getattr(self.parser, "parser", None):
            print("📄 Testing file parsing with actual file path:\n")

            try:
                source = self.parser.create_source(FILE_CONTENT_REAL_FILE_PART, info)
                print(f"  ✅ Created SourceMessage for file: {source.doc_path}")
                # The parser would parse the file content if the file exists
            except Exception as e:
                print(f"  ⚠️  File parsing note: {e}")
            print()


if __name__ == "__main__":
    demo = FileContentParserDemo()
    demo.run()
