"""Base class and utilities for parser demos."""

from typing import Any

from examples.mem_reader.builders import build_llm_and_embedder
from examples.mem_reader.utils import pretty_print_dict
from memos.memories.textual.item import SourceMessage


class BaseParserDemo:
    """Base class for all parser demos."""

    def __init__(self):
        print(f"\n🚀 Initializing {self.__class__.__name__}...")
        self.embedder, self.llm = build_llm_and_embedder()
        self.parser = self.create_parser()
        print("✅ Initialization complete.\n")

    def create_parser(self):
        """Create and return the specific parser instance."""
        raise NotImplementedError

    def run(self):
        """Run the main demo logic."""
        raise NotImplementedError

    def demo_source_creation(
        self, message: Any, info: dict, **kwargs
    ) -> SourceMessage | list[SourceMessage]:
        """Demonstrate creating a SourceMessage from raw input."""
        print(f"📝 Creating SourceMessage from: {str(message)[:100]}...")
        source = self.parser.create_source(message, info, **kwargs)

        if isinstance(source, list):
            print(f"  ✅ Created {len(source)} SourceMessage(s)")
            for i, s in enumerate(source):
                print(f"    [{i}] Type: {s.type}, Role: {getattr(s, 'role', 'N/A')}")
        else:
            print("  ✅ Created SourceMessage:")
            print(f"     - Type: {source.type}")
            if hasattr(source, "role"):
                print(f"     - Role: {source.role}")
            if source.content:
                print(f"     - Content: {str(source.content)[:60]}...")

        return source

    def demo_rebuild(self, source: SourceMessage | list[SourceMessage]):
        """Demonstrate rebuilding raw message from SourceMessage."""
        print("\n🔄 Rebuilding message from source...")

        # Handle list of sources (take first one for demo if it's a list)
        src_to_rebuild = source[0] if isinstance(source, list) else source

        rebuilt = self.parser.rebuild_from_source(src_to_rebuild)
        print("  ✅ Rebuilt result:")
        if isinstance(rebuilt, dict):
            pretty_print_dict(rebuilt)
        else:
            print(f"     {rebuilt}")

    def demo_parse_fast(self, message: Any, info: dict):
        """Demonstrate fast parsing (if supported)."""
        if not hasattr(self.parser, "parse_fast"):
            return

        print("\n⚡️ Running parse_fast...")
        try:
            memory_items = self.parser.parse_fast(message, info)
            print(f"  📊 Generated {len(memory_items)} memory item(s)")
            if memory_items:
                item = memory_items[0]
                print(f"     - Memory: {item.memory[:60]}...")
                print(f"     - Type: {item.metadata.memory_type}")
        except Exception as e:
            print(f"  ⚠️  parse_fast not applicable or failed: {e}")
