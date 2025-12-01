"""Compare SimpleStructMemReader and MultiModalStructMemReader outputs.

This example demonstrates the differences between simple_struct and multi_modal_struct
in both fast and fine modes.
"""

import os
import sys

from pathlib import Path

from dotenv import load_dotenv

from memos.configs.mem_reader import (
    MultiModalStructMemReaderConfig,
    SimpleStructMemReaderConfig,
)
from memos.memories.textual.item import TextualMemoryItem


# Add src directory to path
project_root = Path(__file__).parent.parent.parent
src_path = project_root / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

# Load environment variables
load_dotenv()


def get_reader_config() -> dict:
    """Get reader configuration from environment variables."""
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    ollama_api_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")

    # LLM config
    llm_backend = os.getenv("MEM_READER_LLM_BACKEND", "openai")
    if llm_backend == "ollama":
        llm_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": os.getenv("MEM_READER_LLM_MODEL", "qwen3:0.6b"),
                "api_base": ollama_api_base,
                "temperature": float(os.getenv("MEM_READER_LLM_TEMPERATURE", "0.0")),
                "remove_think_prefix": os.getenv(
                    "MEM_READER_LLM_REMOVE_THINK_PREFIX", "true"
                ).lower()
                == "true",
                "max_tokens": int(os.getenv("MEM_READER_LLM_MAX_TOKENS", "8192")),
            },
        }
    else:  # openai
        llm_config = {
            "backend": "openai",
            "config": {
                "model_name_or_path": os.getenv("MEM_READER_LLM_MODEL", "gpt-4o-mini"),
                "api_key": openai_api_key or os.getenv("MEMRADER_API_KEY", "EMPTY"),
                "api_base": openai_base_url,
                "temperature": float(os.getenv("MEM_READER_LLM_TEMPERATURE", "0.5")),
                "remove_think_prefix": os.getenv(
                    "MEM_READER_LLM_REMOVE_THINK_PREFIX", "true"
                ).lower()
                == "true",
                "max_tokens": int(os.getenv("MEM_READER_LLM_MAX_TOKENS", "8192")),
            },
        }

    # Embedder config
    embedder_backend = os.getenv(
        "MEM_READER_EMBEDDER_BACKEND", os.getenv("MOS_EMBEDDER_BACKEND", "ollama")
    )
    if embedder_backend == "universal_api":
        embedder_config = {
            "backend": "universal_api",
            "config": {
                "provider": os.getenv(
                    "MEM_READER_EMBEDDER_PROVIDER",
                    os.getenv("MOS_EMBEDDER_PROVIDER", "openai"),
                ),
                "api_key": os.getenv(
                    "MEM_READER_EMBEDDER_API_KEY",
                    os.getenv("MOS_EMBEDDER_API_KEY", openai_api_key or "sk-xxxx"),
                ),
                "model_name_or_path": os.getenv(
                    "MEM_READER_EMBEDDER_MODEL",
                    os.getenv("MOS_EMBEDDER_MODEL", "text-embedding-3-large"),
                ),
                "base_url": os.getenv(
                    "MEM_READER_EMBEDDER_API_BASE",
                    os.getenv("MOS_EMBEDDER_API_BASE", openai_base_url),
                ),
            },
        }
    else:  # ollama
        embedder_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": os.getenv(
                    "MEM_READER_EMBEDDER_MODEL",
                    os.getenv("MOS_EMBEDDER_MODEL", "nomic-embed-text:latest"),
                ),
                "api_base": ollama_api_base,
            },
        }

    return {
        "llm": llm_config,
        "embedder": embedder_config,
        "chunker": {
            "backend": "sentence",
            "config": {
                "tokenizer_or_token_counter": "gpt2",
                "chunk_size": 512,
                "chunk_overlap": 128,
                "min_sentences_per_chunk": 1,
            },
        },
    }


def print_memory_item(item: TextualMemoryItem, prefix: str = "", max_length: int = 500):
    """Print a memory item in a readable format."""
    print(f"{prefix}Memory ID: {item.id}")
    print(f"{prefix}Memory Type: {item.metadata.memory_type}")
    print(f"{prefix}Tags: {item.metadata.tags}")
    memory_preview = (
        item.memory[:max_length] + "..." if len(item.memory) > max_length else item.memory
    )
    print(f"{prefix}Memory: {memory_preview}")
    print(f"{prefix}Key: {item.metadata.key}")
    if item.metadata.background:
        bg_preview = (
            item.metadata.background[:max_length] + "..."
            if len(item.metadata.background) > max_length
            else item.metadata.background
        )
        print(f"{prefix}Background: {bg_preview}")
    print(f"{prefix}Sources count: {len(item.metadata.sources) if item.metadata.sources else 0}")
    print()


def compare_readers():
    """Compare SimpleStructMemReader and MultiModalStructMemReader."""
    print("=" * 80)
    print("Comparing SimpleStructMemReader vs MultiModalStructMemReader")
    print("=" * 80)
    print()

    # Test data - simple chat messages
    scene_data = [
        [
            {"role": "user", "chat_time": "3 May 2025", "content": "I'm feeling a bit down today."},
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "I'm sorry to hear that. Do you want to talk about what's been going on?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "It's just been a tough couple of days, you know? Everything feels a bit overwhelming, and I just can't seem to shake it off.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "It sounds like you're going through a lot right now. Sometimes it helps to talk things out. Is there something specific that's been weighing on you, or is it more of a general feeling?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "It's a mix, I guess. Work's been really stressful, and on top of that, I've been feeling kinda disconnected from the people around me.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "That can be really draining, especially when you're feeling isolated on top of the stress. Do you think there's something from your past that's contributing to how you're feeling now? Sometimes our emotions are tied to older experiences.",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "Yeah, now that you mention it… I've been thinking a lot about my childhood lately. I didn't have the easiest upbringing. My parents were always busy, and I often felt like I had to figure things out on my own. I remember one winter, I got really sick with a high fever. My parents were both working, and I didn't want to bother them. I just lay in bed, crying by myself, not knowing what to do.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "That must have been very lonely. Growing up without that support can really make you feel like you have to handle everything on your own. How do you think that experience has affected you now?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "Yeah, it was really lonely. I remember spending a lot of time doing things on my own, like drawing, because it was my only way to escape. I used to draw animals, and I created my own little world on paper. It was peaceful in a way, just me and my imagination, with no outside distractions.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "Drawing sounds like a beautiful way to express yourself and find some peace in that solitude. It must have been a very quiet and private world for you. Do you think that sense of loneliness from back then has shaped how you connect with others today?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "I think it has. I've always found it hard to let others in. I feel like I have to handle everything on my own. If I rely on someone else, I feel vulnerable, and I start to feel that loneliness again.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "It sounds like this was a protective mechanism that helped you cope with your feelings of loneliness back then. But as you've grown, it seems like this pattern might not be serving you as well anymore. Have you thought about trying to break this cycle, or finding new ways to connect with others?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "I've thought about it, though it's hard. But I also know I can't keep going like this forever. Maybe it's time to seek some help.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "It's a big step, but a positive one. Exploring your emotions and past experiences could really help you understand how they've shaped your present. Therapy could be a great place to start, as it would help you connect with both yourself and others. Would you be open to trying it?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "I'm open to trying. Thank you for encouraging me. It feels like it might be a good starting point for me.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "I'm really glad to hear that. Taking that first step is always difficult, but you've made an important decision. If you need help finding the right therapist, or just want to talk, I'm here for you.",
            },
        ],
        [
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "This week I've been feeling a bit off, especially when playing tennis. My body just doesn't feel right.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "It sounds like you've been having some physical discomfort lately. Where specifically are you feeling unwell? Is there something particular about tennis that's been difficult?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "I just feel a bit fatigued, and every time I play tennis, my movements feel off. I used to play pretty well, but lately, I've been feeling weak and my movements aren't as coordinated as they used to be.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "Physical discomfort can definitely affect performance, especially in a sport like tennis that requires quick reactions and coordination. Have you noticed anything specific that might be causing these changes? Could it be overtraining, or is there another physical issue making you feel off?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "I think it might be due to stress and lack of sleep recently. I just feel drained all the time. Plus, I've been frustrated with my tennis performance, which makes me feel even worse, like I'm stuck in a vicious cycle.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "Stress and poor sleep quality can definitely affect your physical performance, especially in sports. When you're also feeling down about your performance, it's easy to fall into a negative cycle. Have you tried anything to relieve some of the stress, or to improve your sleep?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "I've tried some relaxation techniques, like deep breathing and simple meditation, but it doesn't seem to help much. I still can't focus during tennis, and I feel like my mind is distracted by other things.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "Relaxation techniques like deep breathing and meditation can help reduce stress, but sometimes we need a more structured approach to improve both our physical and mental state. For example, you might want to focus on specific aspects of your tennis training, or adjust your rest and recovery time. Have you thought about setting smaller goals for yourself? Like focusing on a specific tennis move each day, rather than expecting perfection right away? That might help you gradually regain confidence.",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "That's a good idea. I think I've been expecting too much from myself, which just makes me more anxious. Maybe I can start with small practice sessions and gradually find my rhythm again.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "Exactly! Setting small and clear goals will help reduce pressure and give you a sense of accomplishment. And don't forget that rest is just as important—taking time to recover will help you feel better physically and mentally. Both physical and mental recovery are key to improving your performance and health.",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "Thanks, I feel like I need to rethink a few things. Maybe I really need to be kinder to myself and take things step by step.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "You're on the right track. Rethinking things and giving yourself space and patience is so important. You've already taken the first step, now just keep moving forward, one step at a time. If you need anything, I'm always here to help.",
            },
        ],
        [
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "Yesterday at 3 PM I had a meeting with my team about the new project. We discussed the timeline and I'm concerned we won't meet the deadline of December 15th.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "I understand your concern about the project timeline. What specific challenges do you think might prevent your team from meeting the December 15th deadline?",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "We have too many requirements to implement in just two weeks. The backend team needs at least until December 10th to finish their part, which leaves almost no time for testing before the deadline.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "That's definitely a tight timeline. Have you considered prioritizing the requirements to focus on the most critical features first? You might also want to discuss with stakeholders about possibly extending the deadline or reducing the scope for this initial release.",
            },
            {
                "role": "user",
                "chat_time": "3 May 2025",
                "content": "That's a good point. We have a follow-up meeting scheduled for tomorrow morning at 9:30 AM. I'll suggest we prioritize features and maybe propose pushing the deadline to January 5th next year.",
            },
            {
                "role": "assistant",
                "chat_time": "3 May 2025",
                "content": "That sounds like a solid approach. Coming to the meeting with both a prioritization strategy and a specific alternative deadline shows you've thought through the problem carefully. It might also help to bring some data about similar past projects and how long they took to complete, if you have that information available.",
            },
        ],
    ]

    info = {"user_id": "test_user", "session_id": "test_session"}

    # Get config
    config_dict = get_reader_config()

    # Initialize readers
    print("Initializing readers...")
    simple_config = SimpleStructMemReaderConfig(**config_dict)
    multimodal_config = MultiModalStructMemReaderConfig(**config_dict)

    from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
    from memos.mem_reader.simple_struct import SimpleStructMemReader

    simple_reader = SimpleStructMemReader(simple_config)
    multimodal_reader = MultiModalStructMemReader(multimodal_config)
    print("Readers initialized.\n")
    print(f"Using LLM: {config_dict['llm']['backend']}")
    print(f"Using Embedder: {config_dict['embedder']['backend']}")
    print()

    # Test FAST mode
    print("=" * 80)
    print("FAST MODE COMPARISON")
    print("=" * 80)
    print()

    print("-" * 80)
    print("SimpleStructMemReader (FAST):")
    print("-" * 80)
    try:
        simple_fast = simple_reader.get_memory(scene_data, "chat", info, mode="fast")
        if simple_fast and len(simple_fast) > 0:
            for scene_idx, scene_memories in enumerate(simple_fast):
                print(f"\nScene {scene_idx + 1}:")
                for item_idx, item in enumerate(scene_memories):
                    print_memory_item(item, prefix=f"  [{item_idx + 1}] ")
        else:
            print("  No memories generated.")
    except Exception as e:
        print(f"  Error: {e}")
        import traceback

        traceback.print_exc()

    print("\n" + "-" * 80)
    print("MultiModalStructMemReader (FAST):")
    print("-" * 80)
    try:
        multimodal_fast = multimodal_reader.get_memory(scene_data, "chat", info, mode="fast")
        if multimodal_fast and len(multimodal_fast) > 0:
            for scene_idx, scene_memories in enumerate(multimodal_fast):
                print(f"\nScene {scene_idx + 1}:")
                for item_idx, item in enumerate(scene_memories):
                    print_memory_item(item, prefix=f"  [{item_idx + 1}] ")
        else:
            print("  No memories generated.")
    except Exception as e:
        print(f"  Error: {e}")
        import traceback

        traceback.print_exc()

    # Test FINE mode
    print("\n" + "=" * 80)
    print("FINE MODE COMPARISON")
    print("=" * 80)
    print()

    print("-" * 80)
    print("SimpleStructMemReader (FINE):")
    print("-" * 80)
    try:
        simple_fine = simple_reader.get_memory(scene_data, "chat", info, mode="fine")
        if simple_fine and len(simple_fine) > 0:
            for scene_idx, scene_memories in enumerate(simple_fine):
                print(f"\nScene {scene_idx + 1}:")
                for item_idx, item in enumerate(scene_memories):
                    print_memory_item(item, prefix=f"  [{item_idx + 1}] ")
        else:
            print("  No memories generated.")
    except Exception as e:
        print(f"  Error: {e}")
        import traceback

        traceback.print_exc()

    print("\n" + "-" * 80)
    print("MultiModalStructMemReader (FINE):")
    print("-" * 80)
    try:
        multimodal_fine = multimodal_reader.get_memory(scene_data, "chat", info, mode="fine")
        if multimodal_fine and len(multimodal_fine) > 0:
            for scene_idx, scene_memories in enumerate(multimodal_fine):
                print(f"\nScene {scene_idx + 1}:")
                for item_idx, item in enumerate(scene_memories):
                    print_memory_item(item, prefix=f"  [{item_idx + 1}] ")
        else:
            print("  No memories generated.")
    except Exception as e:
        print(f"  Error: {e}")
        import traceback

        traceback.print_exc()

    # Summary comparison
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print()

    def count_memories(memories_list):
        """Count total memories across all scenes."""
        if not memories_list:
            return 0
        return sum(len(scene) for scene in memories_list if scene)

    simple_fast_count = count_memories(simple_fast) if "simple_fast" in locals() else 0
    multimodal_fast_count = count_memories(multimodal_fast) if "multimodal_fast" in locals() else 0
    simple_fine_count = count_memories(simple_fine) if "simple_fine" in locals() else 0
    multimodal_fine_count = count_memories(multimodal_fine) if "multimodal_fine" in locals() else 0

    print(f"SimpleStructMemReader FAST:  {simple_fast_count} memories")
    print(f"MultiModalStructMemReader FAST:  {multimodal_fast_count} memories")
    print(f"SimpleStructMemReader FINE:  {simple_fine_count} memories")
    print(f"MultiModalStructMemReader FINE:  {multimodal_fine_count} memories")
    print()

    print("Key Differences:")
    print("1. Both readers should produce similar results for simple text messages")
    print("2. MultiModalStructMemReader can handle multimodal content (images, files, etc.)")
    print("3. FINE mode uses LLM to extract structured memories from aggregated windows")
    print("4. FAST mode directly aggregates messages into windows without LLM processing")


if __name__ == "__main__":
    compare_readers()
