"""Demo for UserParser."""

from examples.mem_reader.samples import USER_MESSAGE_CASES
from memos.mem_reader.read_multi_modal.user_parser import UserParser

from ._base import BaseParserDemo


class UserParserDemo(BaseParserDemo):
    def create_parser(self):
        return UserParser(embedder=self.embedder, llm=self.llm)

    def run(self):
        print("=== UserParser Demo ===")

        info = {"user_id": "user1", "session_id": "session1"}

        for case in USER_MESSAGE_CASES:
            print(f"\n--- Case: {case.description} ---")
            for msg in case.scene_data:
                sources = self.demo_source_creation(msg, info)

                # Rebuild all sources to show full multimodal support
                if isinstance(sources, list):
                    for i, src in enumerate(sources):
                        print(f"\n🔄 Rebuilding source part {i + 1} ({src.type})...")
                        rebuilt = self.parser.rebuild_from_source(src)
                        print("  ✅ Rebuilt result:")
                        if isinstance(rebuilt, dict):
                            from examples.mem_reader.utils import pretty_print_dict

                            pretty_print_dict(rebuilt)
                        else:
                            print(f"     {rebuilt}")
                else:
                    self.demo_rebuild(sources)

                self.demo_parse_fast(msg, info)


if __name__ == "__main__":
    demo = UserParserDemo()
    demo.run()
