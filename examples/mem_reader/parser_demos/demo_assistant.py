"""Demo for AssistantParser."""

from examples.mem_reader.samples import ASSISTANT_MESSAGE_CASES
from memos.mem_reader.read_multi_modal.assistant_parser import AssistantParser

from ._base import BaseParserDemo


class AssistantParserDemo(BaseParserDemo):
    def create_parser(self):
        parser = AssistantParser(embedder=self.embedder, llm=self.llm)

        # Workaround: AssistantParser.rebuild_from_source is empty in src.
        # Patch it to return content for demo visualization, aligning with legacy behavior.
        original_rebuild = parser.rebuild_from_source

        def patched_rebuild(source):
            if source.role == "assistant":
                # Only handling simple text content as per legacy example scope
                return {
                    "role": "assistant",
                    "content": source.content,
                }
            return original_rebuild(source)

        parser.rebuild_from_source = patched_rebuild
        return parser

    def run(self):
        print("=== AssistantParser Demo ===")

        info = {"user_id": "user1", "session_id": "session1"}

        for case in ASSISTANT_MESSAGE_CASES:
            print(f"\n--- Case: {case.description} ---")
            for msg in case.scene_data:
                source = self.demo_source_creation(msg, info)
                self.demo_rebuild(source)
                self.demo_parse_fast(msg, info)


if __name__ == "__main__":
    demo = AssistantParserDemo()
    demo.run()
