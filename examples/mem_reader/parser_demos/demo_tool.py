"""Demo for ToolParser."""

from examples.mem_reader.samples import TOOL_MESSAGE_CASES
from memos.mem_reader.read_multi_modal.tool_parser import ToolParser

from ._base import BaseParserDemo


class ToolParserDemo(BaseParserDemo):
    def create_parser(self):
        return ToolParser(embedder=self.embedder, llm=self.llm)

    def run(self):
        print("=== ToolParser Demo ===")

        info = {"user_id": "user1", "session_id": "session1"}

        for case in TOOL_MESSAGE_CASES:
            print(f"\n--- Case: {case.description} ---")
            for msg in case.scene_data:
                source = self.demo_source_creation(msg, info)
                self.demo_rebuild(source)
                self.demo_parse_fast(msg, info)


if __name__ == "__main__":
    demo = ToolParserDemo()
    demo.run()
