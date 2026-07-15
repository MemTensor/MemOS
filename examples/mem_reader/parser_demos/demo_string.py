"""Demo for StringParser."""

from examples.mem_reader.samples import STRING_MESSAGE_CASES
from memos.mem_reader.read_multi_modal.string_parser import StringParser

from ._base import BaseParserDemo


class StringParserDemo(BaseParserDemo):
    def create_parser(self):
        return StringParser(embedder=self.embedder, llm=self.llm)

    def run(self):
        print("=== StringParser Demo ===")

        info = {"user_id": "user1", "session_id": "session1"}

        for case in STRING_MESSAGE_CASES:
            print(f"\n--- Case: {case.description} ---")
            print("📝 Processing string messages:\n")
            for i, msg in enumerate(case.scene_data, 1):
                print(f"Message {i}: {msg[:50]}...")
                source = self.demo_source_creation(msg, info)
                self.demo_rebuild(source)
                print()


if __name__ == "__main__":
    demo = StringParserDemo()
    demo.run()
