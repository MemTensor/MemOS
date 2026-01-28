"""Demo for SystemParser."""

from examples.mem_reader.samples import SYSTEM_MESSAGE_CASES
from memos.mem_reader.read_multi_modal.system_parser import SystemParser

from ._base import BaseParserDemo


class SystemParserDemo(BaseParserDemo):
    def create_parser(self):
        return SystemParser(embedder=self.embedder, llm=self.llm)

    def run(self):
        print("=== SystemParser Demo ===")

        info = {"user_id": "user1", "session_id": "session1"}

        for case in SYSTEM_MESSAGE_CASES:
            print(f"\n--- Case: {case.description} ---")
            for msg in case.scene_data:
                # Workaround: SystemParser in src only supports str/dict content, not list.
                # Since we cannot modify src, we flatten list content here.
                msg_to_process = msg
                if isinstance(msg.get("content"), list):
                    msg_to_process = msg.copy()
                    content_list = msg["content"]
                    merged_text = "".join(
                        part.get("text", "")
                        for part in content_list
                        if isinstance(part, dict) and part.get("type") == "text"
                    )
                    msg_to_process["content"] = merged_text

                source = self.demo_source_creation(msg_to_process, info)
                self.demo_rebuild(source)
                self.demo_parse_fast(msg_to_process, info)


if __name__ == "__main__":
    demo = SystemParserDemo()
    demo.run()
