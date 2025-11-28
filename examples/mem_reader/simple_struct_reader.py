import argparse
import json
import os
import time

from typing import Any

from dotenv import load_dotenv

from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


# Load environment variables from .env file
load_dotenv()


def print_textual_memory_item(
    item: TextualMemoryItem, max_memory_length: int = 200, indent: int = 0
):
    """
    Print a TextualMemoryItem in a structured format.

    Args:
        item: The TextualMemoryItem to print
        max_memory_length: Maximum length of memory content to display
        indent: Number of spaces for indentation
    """
    indent_str = " " * indent
    print(f"{indent_str}{'=' * 80}")
    print(f"{indent_str}TextualMemoryItem")
    print(f"{indent_str}{'=' * 80}")
    print(f"{indent_str}ID: {item.id}")
    print(
        f"{indent_str}Memory: {item.memory[:max_memory_length]}{'...' if len(item.memory) > max_memory_length else ''}"
    )
    print(f"{indent_str}Memory Length: {len(item.memory)} characters")

    # Print metadata
    if hasattr(item.metadata, "user_id"):
        print(f"{indent_str}User ID: {item.metadata.user_id}")
    if hasattr(item.metadata, "session_id"):
        print(f"{indent_str}Session ID: {item.metadata.session_id}")
    if hasattr(item.metadata, "memory_type"):
        print(f"{indent_str}Memory Type: {item.metadata.memory_type}")
    if hasattr(item.metadata, "type"):
        print(f"{indent_str}Type: {item.metadata.type}")
    if hasattr(item.metadata, "key") and item.metadata.key:
        print(f"{indent_str}Key: {item.metadata.key}")
    if hasattr(item.metadata, "tags") and item.metadata.tags:
        print(f"{indent_str}Tags: {', '.join(item.metadata.tags)}")
    if hasattr(item.metadata, "confidence"):
        print(f"{indent_str}Confidence: {item.metadata.confidence}")
    if hasattr(item.metadata, "status"):
        print(f"{indent_str}Status: {item.metadata.status}")
    if hasattr(item.metadata, "background") and item.metadata.background:
        bg_preview = (
            item.metadata.background[:100] + "..."
            if len(item.metadata.background) > 100
            else item.metadata.background
        )
        print(f"{indent_str}Background: {bg_preview}")
    if hasattr(item.metadata, "sources") and item.metadata.sources:
        print(f"{indent_str}Sources ({len(item.metadata.sources)}):")
        for i, source in enumerate(item.metadata.sources):
            source_info = []
            if hasattr(source, "type"):
                source_info.append(f"type={source.type}")
            if hasattr(source, "role"):
                source_info.append(f"role={source.role}")
            if hasattr(source, "doc_path"):
                source_info.append(f"doc_path={source.doc_path}")
            if hasattr(source, "chat_time"):
                source_info.append(f"chat_time={source.chat_time}")
            if hasattr(source, "index") and source.index is not None:
                source_info.append(f"index={source.index}")
            print(f"{indent_str}  [{i + 1}] {', '.join(source_info)}")
    if hasattr(item.metadata, "created_at"):
        print(f"{indent_str}Created At: {item.metadata.created_at}")
    if hasattr(item.metadata, "updated_at"):
        print(f"{indent_str}Updated At: {item.metadata.updated_at}")
    if hasattr(item.metadata, "embedding") and item.metadata.embedding:
        print(f"{indent_str}Embedding: [vector of {len(item.metadata.embedding)} dimensions]")
    print(f"{indent_str}{'=' * 80}\n")


def print_textual_memory_item_json(item: TextualMemoryItem, indent: int = 2):
    """
    Print a TextualMemoryItem as formatted JSON.

    Args:
        item: The TextualMemoryItem to print
        indent: JSON indentation level
    """
    # Convert to dict and exclude embedding for readability
    data = item.to_dict()
    if "metadata" in data and "embedding" in data["metadata"]:
        embedding = data["metadata"]["embedding"]
        if embedding:
            data["metadata"]["embedding"] = f"[vector of {len(embedding)} dimensions]"

    print(json.dumps(data, indent=indent, ensure_ascii=False))


def get_reader_config() -> dict[str, Any]:
    """
    Get reader configuration from environment variables.

    Returns a dictionary that can be used to create SimpleStructMemReaderConfig.
    Similar to APIConfig.get_reader_config() in server_router_api.py.

    Returns:
        Configuration dictionary for SimpleStructMemReaderConfig
    """
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    ollama_api_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")

    # Get LLM backend and config
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

    # Get embedder backend and config
    embedder_backend = os.getenv(
        "MEM_READER_EMBEDDER_BACKEND", os.getenv("MOS_EMBEDDER_BACKEND", "ollama")
    )
    if embedder_backend == "universal_api":
        embedder_config = {
            "backend": "universal_api",
            "config": {
                "provider": os.getenv(
                    "MEM_READER_EMBEDDER_PROVIDER", os.getenv("MOS_EMBEDDER_PROVIDER", "openai")
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


def main():
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Test Mem-Reader with structured output")
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: 'text' for structured text, 'json' for JSON format (default: text)",
    )
    parser.add_argument(
        "--max-memory-length",
        type=int,
        default=200,
        help="Maximum length of memory content to display in text format (default: 200)",
    )
    args = parser.parse_args()

    # 1. Create Configuration from environment variables or JSON file
    # Try to get config from environment variables first
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if openai_api_key:
        # Use environment variables (similar to server_router_api.py)
        config_dict = get_reader_config()
        reader_config = SimpleStructMemReaderConfig.model_validate(config_dict)
    else:
        # Fall back to JSON file
        reader_config = SimpleStructMemReaderConfig.from_json_file(
            "examples/data/config/simple_struct_reader_config.json"
        )
    reader = SimpleStructMemReader(reader_config)

    # 2. Define scene data
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

    print("=== Mem-Reader Fast vs Fine Mode Comparison ===\n")

    # 3. Test Fine Mode (default)
    print("🔄 Testing FINE mode (default, with LLM processing)...")
    start_time = time.time()
    fine_memory = reader.get_memory(
        scene_data, type="chat", info={"user_id": "user1", "session_id": "session1"}, mode="fine"
    )
    fine_time = time.time() - start_time
    print(f"✅ Fine mode completed in {fine_time:.2f} seconds")
    print(f"📊 Fine mode generated {sum(len(mem_list) for mem_list in fine_memory)} memory items")

    # 4. Test Fast Mode
    print("\n⚡ Testing FAST mode (quick processing, no LLM calls)...")
    start_time = time.time()
    fast_memory = reader.get_memory(
        scene_data, type="chat", info={"user_id": "user1", "session_id": "session1"}, mode="fast"
    )
    fast_time = time.time() - start_time
    print(f"✅ Fast mode completed in {fast_time:.2f} seconds")
    print(f"📊 Fast mode generated {sum(len(mem_list) for mem_list in fast_memory)} memory items")

    # 5. Performance Comparison
    print("\n📈 Performance Comparison:")
    print(f"   Fine mode: {fine_time:.2f}s")
    print(f"   Fast mode: {fast_time:.2f}s")
    print(f"   Speed improvement: {fine_time / fast_time:.1f}x faster")

    # 6. Show sample results from both modes
    print("\n🔍 Sample Results Comparison:")
    print("\n--- FINE Mode Results (first 3 items) ---")
    for i, mem_list in enumerate(fine_memory[:3]):
        for j, mem_item in enumerate(mem_list[:2]):  # Show first 2 items from each list
            print(f"\n[Scene {i}][Item {j}]")
            if args.format == "json":
                print_textual_memory_item_json(mem_item, indent=2)
            else:
                print_textual_memory_item(
                    mem_item, max_memory_length=args.max_memory_length, indent=2
                )

    print("\n--- FAST Mode Results (first 3 items) ---")
    for i, mem_list in enumerate(fast_memory[:3]):
        for j, mem_item in enumerate(mem_list[:2]):  # Show first 2 items from each list
            print(f"\n[Scene {i}][Item {j}]")
            if args.format == "json":
                print_textual_memory_item_json(mem_item, indent=2)
            else:
                print_textual_memory_item(
                    mem_item, max_memory_length=args.max_memory_length, indent=2
                )

    # 7. Example of transfer fast mode result into fine result
    fast_mode_memories = [
        TextualMemoryItem(
            id="4553141b-3a33-4548-b779-e677ec797a9f",
            memory="user: Nate:Oh cool! I might check that one out some time soon! I do love watching classics.\nassistant: Joanna:Yep, that movie is awesome. I first watched it around 3 years ago. I even went out and got a physical copy!\nuser: Nate:Sounds cool! Have you seen it a lot? sounds like you know the movie well!\nassistant: Joanna:A few times. It's one of my favorites! I really like the idea and the acting.\nuser: Nate:Cool! I'll definitely check it out. Thanks for the recommendation!\nassistant: Joanna:No problem, Nate! Let me know if you like it!\n",
            metadata=TreeNodeTextualMemoryMetadata(
                user_id="nate_test",
                session_id="root_session",
                status="activated",
                type="fact",
                key="user: Nate:Oh cool",
                confidence=0.9900000095367432,
                source=None,
                tags=["mode:fast", "lang:en", "role:assistant", "role:user"],
                visibility=None,
                updated_at="2025-10-16T17:16:30.094877+08:00",
                memory_type="LongTermMemory",
                sources=[
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=0,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=1,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=2,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=3,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=4,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=5,
                    ),
                ],
                embedding=None,
                created_at="2025-10-16T17:16:30.094919+08:00",
                usage=[],
                background="",
            ),
        ),
        TextualMemoryItem(
            id="752e42fa-92b6-491a-a430-6864a7730fba",
            memory="user: Nate:It was! How about you? Do you have any hobbies you love?\nassistant: Joanna:Yeah! Besides writing, I also enjoy reading, watching movies, and exploring nature. Anything else you enjoy doing, Nate?\nuser: Nate:Playing video games and watching movies are my main hobbies.\nassistant: Joanna:Cool, Nate! So we both have similar interests. What type of movies do you like best?\nuser: Nate:I love action and sci-fi movies, the effects are so cool! What about you, what's your favorite genre?\nassistant: Joanna:I'm all about dramas and romcoms. I love getting immersed in the feelings and plots.\nuser: Nate:Wow, movies can be so powerful! Do you have any recommendations for me?\nassistant: Joanna:Yeah, totally! Have you seen this romantic drama that's all about memory and relationships? It's such a good one.\nuser: Nate:Oh cool! I might check that one out some time soon! I do love watching classics.\nassistant: Joanna:Yep, that movie is awesome. I first watched it around 3 years ago. I even went out and got a physical copy!\n",
            metadata=TreeNodeTextualMemoryMetadata(
                user_id="nate_test",
                session_id="root_session",
                status="activated",
                type="fact",
                key="user: Nate:It was",
                confidence=0.9900000095367432,
                source=None,
                tags=["mode:fast", "lang:en", "role:assistant", "role:user"],
                visibility=None,
                updated_at="2025-10-16T17:16:30.095726+08:00",
                memory_type="LongTermMemory",
                sources=[
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=0,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=1,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=2,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=3,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=4,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=5,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=6,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=7,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=8,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=9,
                    ),
                ],
                embedding=None,
                created_at="2025-10-16T17:16:30.095767+08:00",
                usage=[],
                background="",
            ),
        ),
        TextualMemoryItem(
            id="c9cf448c-deee-43a8-bafd-eb15fde535b2",
            memory="user: Nate:Hey Joanna! Long time no see! What's up? Anything fun going on?\nassistant: Joanna:Hey Nate! Long time no see! I've been working on a project lately - it's been pretty cool. What about you - any fun projects or hobbies?\nuser: Nate:Hey Joanna! That's cool! I won my first video game tournament last week - so exciting!\nassistant: Joanna:Wow Nate! Congrats on winning! Tell me more - what game was it?\nuser: Nate:Thanks! it's a team shooter game.\nassistant: Joanna:Wow, great job! What was is called?\nuser: Nate:The game was called Counter-Strike: Global Offensive, and me and my team had a blast to the very end!\nassistant: Joanna:Cool, Nate! Sounds like a fun experience, even if I'm not into games.\nuser: Nate:It was! How about you? Do you have any hobbies you love?\nassistant: Joanna:Yeah! Besides writing, I also enjoy reading, watching movies, and exploring nature. Anything else you enjoy doing, Nate?\n",
            metadata=TreeNodeTextualMemoryMetadata(
                user_id="nate_test",
                session_id="root_session",
                status="activated",
                type="fact",
                key="user: Nate:Hey Joanna",
                confidence=0.9900000095367432,
                source=None,
                tags=["mode:fast", "lang:en", "role:assistant", "role:user"],
                visibility=None,
                updated_at="2025-10-16T17:16:30.098208+08:00",
                memory_type="LongTermMemory",
                sources=[
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=0,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=1,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=2,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=3,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=4,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=5,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=6,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=7,
                    ),
                    SourceMessage(
                        type="chat",
                        role="user",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=8,
                    ),
                    SourceMessage(
                        type="chat",
                        role="assistant",
                        chat_time="7:31 pm on 21 January, 2022",
                        message_id=None,
                        content=None,
                        doc_path=None,
                        index=9,
                    ),
                ],
                embedding=None,
                created_at="2025-10-16T17:16:30.098246+08:00",
                usage=[],
                background="",
            ),
        ),
    ]
    fine_memories = reader.fine_transfer_simple_mem(fast_mode_memories, type="chat")
    print("\n--- Transfer Mode Results (first 3 items) ---")
    for i, mem_list in enumerate(fine_memories[:3]):
        for j, mem_item in enumerate(mem_list[:2]):  # Show first 2 items from each list
            print(f"\n[Scene {i}][Item {j}]")
            if args.format == "json":
                print_textual_memory_item_json(mem_item, indent=2)
            else:
                print_textual_memory_item(
                    mem_item, max_memory_length=args.max_memory_length, indent=2
                )

    # 7. Example of processing documents (only in fine mode)
    print("\n=== Processing Documents (Fine Mode Only) ===")
    # Example document paths (you should replace these with actual document paths)
    doc_paths = [
        "text1.txt",
        "text2.txt",
    ]

    try:
        # 6. Acquiring memories from documents
        doc_memory = reader.get_memory(
            doc_paths,
            "doc",
            info={
                "user_id": "1111",
                "session_id": "2222",
            },
            mode="fine",
        )
        total_items = sum(len(mem_list) for mem_list in doc_memory)
        print(f"\n📄 Document Memory generated {total_items} items")

        # Print structured document memory items
        if doc_memory:
            print("\n--- Document Memory Items (first 3) ---")
            for i, mem_list in enumerate(doc_memory[:3]):
                for j, mem_item in enumerate(mem_list[:3]):  # Show first 3 items from each document
                    print(f"\n[Document {i}][Item {j}]")
                    if args.format == "json":
                        print_textual_memory_item_json(mem_item, indent=2)
                    else:
                        print_textual_memory_item(
                            mem_item, max_memory_length=args.max_memory_length, indent=2
                        )
    except Exception as e:
        print(f"⚠️  Document processing failed: {e}")
        print("   (This is expected if document files don't exist)")

    print("\n🎯 Summary:")
    print(f"   • Fast mode: {fast_time:.2f}s - Quick processing, no LLM calls")
    print(f"   • Fine mode: {fine_time:.2f}s - Full LLM processing for better understanding")
    print("   • Use fast mode for: Real-time applications, high-throughput scenarios")
    print("   • Use fine mode for: Quality analysis, detailed memory extraction")


if __name__ == "__main__":
    main()
