"""Runner for SimpleStructMemReader."""

import time

from examples.mem_reader.samples import SIMPLE_CHAT_SCENE
from examples.mem_reader.settings import get_reader_config
from examples.mem_reader.utils import print_memory_item
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.mem_reader.simple_struct import SimpleStructMemReader


def _print_memory_sets(title: str, memories):
    """memories: list[list[TextualMemoryItem]]"""
    total = sum(len(mem_list) for mem_list in memories)
    print(f"\n{title}")
    print(f"📊 Total memory items: {total}")
    print(f"✅ Extracted {len(memories)} memory sets.")
    for i, memory_list in enumerate(memories):
        print(f"\n--- Window/Conversation {i + 1} Memories ({len(memory_list)} items) ---")
        for item in memory_list:
            print_memory_item(item, indent=2)


def run_simple_reader():
    """Run SimpleStructMemReader with sample data."""
    print("🚀 Initializing SimpleStructMemReader from JSON config...")

    # Use settings config instead of hardcoded JSON
    reader_config = SimpleStructMemReaderConfig(**get_reader_config())
    reader = SimpleStructMemReader(reader_config)
    print("✅ Initialization complete.")

    info = {"user_id": "simple_user", "session_id": "simple_session"}

    print("\n📝 Processing Simple Chat Scene...")
    # SIMPLE_CHAT_SCENE: list[list[dict]] (multiple conversations)

    try:
        # 1) FINE
        print("\n🔄 Testing FINE mode (with LLM)...")
        t0 = time.time()
        fine_memory = reader.get_memory(
            SIMPLE_CHAT_SCENE,
            type="chat",
            info=info,
            mode="fine",
        )
        fine_time = time.time() - t0
        print(f"⏱️ Fine mode time: {fine_time:.2f}s")
        _print_memory_sets("=== FINE Mode Results ===", fine_memory)

        # 2) FAST
        print("\n⚡ Testing FAST mode (no LLM)...")
        t0 = time.time()
        fast_memory = reader.get_memory(
            SIMPLE_CHAT_SCENE,
            type="chat",
            info=info,
            mode="fast",
        )
        fast_time = time.time() - t0
        print(f"⏱️ Fast mode time: {fast_time:.2f}s")
        _print_memory_sets("=== FAST Mode Results ===", fast_memory)

        # 3) Transfer: FAST -> FINE
        # fine_transfer_simple_mem expects a flat list[TextualMemoryItem]
        print("\n🔁 Transfer FAST memories -> FINE...")
        flat_fast_items = [item for mem_list in fast_memory for item in mem_list]

        t0 = time.time()
        transferred = reader.fine_transfer_simple_mem(flat_fast_items, type="chat")
        transfer_time = time.time() - t0

        print(f"⏱️ Transfer time: {transfer_time:.2f}s")
        _print_memory_sets("=== TRANSFER Results (FAST -> FINE) ===", transferred)

        # 4) Documents (Fine only)
        print("\n📄 Processing Documents (Fine Mode Only)...")
        doc_paths = [
            "text1.txt",
            "text2.txt",
        ]

        try:
            t0 = time.time()
            doc_memory = reader.get_memory(
                doc_paths,
                type="doc",
                info={"user_id": "doc_user", "session_id": "doc_session"},
                mode="fine",
            )
            doc_time = time.time() - t0
            print(f"⏱️ Doc fine mode time: {doc_time:.2f}s")
            _print_memory_sets("=== DOC Mode Results (FINE) ===", doc_memory)
        except Exception as e:
            print(f"⚠️  Document processing failed: {e}")
            print("   (This is expected if document files don't exist)")

        # 5) Summary (no speedup)
        print("\n📈 Summary")
        print(f"   Fine:     {fine_time:.2f}s")
        print(f"   Fast:     {fast_time:.2f}s")
        print(f"   Transfer: {transfer_time:.2f}s")

    except Exception as e:
        print(f"❌ Error during processing: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    run_simple_reader()
