#!/usr/bin/env python3
"""
MemOS CoT (Chain of Thought) Usage Example
This example demonstrates how to use CoT functionality with tree textual memory.
It shows how to:
1. Decompose complex questions into sub-questions
2. Get answers for sub-questions using tree_textual_memory
3. Use JSON configuration files with environment variable overrides
"""

import json
import os

# Load environment variables
from dotenv import load_dotenv

from memos.configs.llm import LLMConfigFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.configs.memory import TreeTextMemoryConfig
from memos.mem_os.main import MOS
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.tree import TreeTextMemory


load_dotenv()


def load_and_modify_config(config_path: str) -> dict:
    """Load JSON config and modify it with environment variables."""
    with open(config_path) as f:
        config = json.load(f)

    # Get environment variables
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

    # Modify config to use ollama for embedder and gpt-4o-mini for LLMs
    if "embedder" in config:
        config["embedder"] = {
            "backend": "ollama",
            "config": {"model_name_or_path": "nomic-embed-text:latest"},
        }

    # Modify LLM configs to use gpt-4o-mini
    if "llm" in config:
        config["llm"] = {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": openai_api_key,
                "api_base": openai_base_url,
                "temperature": 0.5,
                "remove_think_prefix": True,
                "max_tokens": 8192,
            },
        }

    if "extractor_llm" in config:
        config["extractor_llm"] = {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": openai_api_key,
                "api_base": openai_base_url,
                "temperature": 0.5,
                "remove_think_prefix": True,
                "max_tokens": 8192,
            },
        }

    if "dispatcher_llm" in config:
        config["dispatcher_llm"] = {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": openai_api_key,
                "api_base": openai_base_url,
                "temperature": 0.5,
                "remove_think_prefix": True,
                "max_tokens": 8192,
            },
        }

    # Modify graph_db config if present
    if "graph_db" in config:
        neo4j_uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
        neo4j_user = os.getenv("NEO4J_USER", "neo4j")
        neo4j_password = os.getenv("NEO4J_PASSWORD", "12345678")

        config["graph_db"] = {
            "backend": "neo4j",
            "config": {
                "uri": neo4j_uri,
                "user": neo4j_user,
                "password": neo4j_password,
                "db_name": "testlcy",
                "auto_create": True,
                "embedding_dimension": 768,
            },
        }

    return config


def setup_llm_config():
    """Setup LLM configuration for CoT operations."""
    # Get environment variables
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    # Use ollama with gpt-4o-mini model
    return LLMConfigFactory(
        backend="openai",
        config={
            "model_name_or_path": "gpt-4o-mini",
            "api_key": openai_api_key,
            "api_base": openai_base_url,
            "temperature": 0.5,
            "remove_think_prefix": True,
            "max_tokens": 8192,
        },
    )


def create_tree_memory():
    """Create a tree textual memory with sample data."""
    print("Creating tree textual memory...")

    # Load and modify configurations
    tree_config_dict = load_and_modify_config("examples/data/config/tree_config.json")
    reader_config_dict = load_and_modify_config(
        "examples/data/config/simple_struct_reader_config.json"
    )

    # Create config objects
    tree_config = TreeTextMemoryConfig.model_validate(tree_config_dict)
    reader_config = SimpleStructMemReaderConfig.model_validate(reader_config_dict)

    # Create tree memory
    tree_memory = TreeTextMemory(tree_config)
    tree_memory.delete_all()  # Clear existing data

    # Create memory reader
    reader = SimpleStructMemReader(reader_config)

    # Sample conversation data
    sample_conversations = [
        [
            {"role": "user", "content": "Tell me about China and its capital."},
            {
                "role": "assistant",
                "content": "China is a country in East Asia. Beijing is its capital city.",
            },
            {"role": "user", "content": "Who is Lang Ping?"},
            {
                "role": "assistant",
                "content": "Lang Ping is a famous Chinese volleyball coach and former player.",
            },
            {"role": "user", "content": "What about Madagascar?"},
            {
                "role": "assistant",
                "content": "Madagascar is an island country in the Indian Ocean. It's known for its unique wildlife.",
            },
            {"role": "user", "content": "Tell me about trade between China and Madagascar."},
            {
                "role": "assistant",
                "content": "China and Madagascar have developed trade relations, particularly in agriculture and mining.",
            },
            {"role": "user", "content": "What about the essential oil industry in Madagascar?"},
            {
                "role": "assistant",
                "content": "The essential oil industry is growing in Madagascar, especially on Nosy Be Island where vanilla and ylang-ylang are produced.",
            },
        ]
    ]

    # Acquire memories using the reader
    memories = reader.get_memory(
        sample_conversations, type="chat", info={"user_id": "cot_user", "session_id": "cot_session"}
    )

    # Add memories to tree structure
    for memory_list in memories:
        tree_memory.add(memory_list)

    print("✓ Added sample conversations to tree memory")
    return tree_memory


def cot_decompose():
    """Test the cot_decompose functionality."""
    print("\n=== Testing CoT Decomposition ===")

    # Setup LLM config
    llm_config = setup_llm_config()

    # Test questions
    test_questions = [
        "Who is the current head coach of the gymnastics team in the capital of the country that Lang Ping represents?",
        "What is the weather like today?",
        "How did the trade relationship between Madagascar and China develop, and how does this relationship affect the market expansion of the essential oil industry on Nosy Be Island?",
    ]

    for i, question in enumerate(test_questions, 1):
        print(f"\nTest {i}: {question}")
        result = MOS.cot_decompose(question, llm_config)
        print(f"✓ Decomposition result: {result}")

        if result.get("is_complex", False):
            sub_questions = result.get("sub_questions", [])
            print(f"✓ Found {len(sub_questions)} sub-questions:")
            for j, sub_q in enumerate(sub_questions, 1):
                print(f"  {j}. {sub_q}")
        else:
            print("✓ Question is not complex, no decomposition needed.")

    return llm_config


def get_sub_answers_with_tree_memory():
    """Test get_sub_answers with tree textual memory."""
    print("\n=== Testing get_sub_answers with Tree Textual Memory ===")

    # Setup
    llm_config = setup_llm_config()
    tree_memory = create_tree_memory()

    # Test sub-questions
    sub_questions = [
        "Which country does Lang Ping represent in volleyball?",
        "What is the capital of this country?",
        "Who is the current head coach of the gymnastics team in this capital?",
    ]

    print("Sub-questions to answer:")
    for i, q in enumerate(sub_questions, 1):
        print(f"  {i}. {q}")
    print("\nGenerating answers using tree memory and LLM...")
    sub_questions, sub_answers = MOS.get_sub_answers(
        sub_questions=sub_questions, search_engine=tree_memory, llm_config=llm_config, top_k=3
    )

    print("✓ Generated answers:")
    for i, (question, answer) in enumerate(zip(sub_questions, sub_answers, strict=False), 1):
        print(f"\n  Sub-question {i}: {question}")
        print(f"  Answer: {answer}")


def complete_cot_workflow():
    """Test the complete CoT workflow from decomposition to final synthesis."""
    print("\n=== Testing Complete CoT Workflow ===")

    # Setup
    llm_config = setup_llm_config()
    tree_memory = create_tree_memory()

    # Complex question
    complex_question = "How did the trade relationship between Madagascar and China develop, and how does this relationship affect the market expansion of the essential oil industry on Nosy Be Island?"

    print(f"Original question: {complex_question}")

    try:
        # Step 1: Decompose the question
        print("\n1. Decomposing question...")
        decomposition_result = MOS.cot_decompose(complex_question, llm_config)
        print(f"✓ Decomposition result: {decomposition_result}")

        if not decomposition_result.get("is_complex", False):
            print("Question is not complex, no decomposition needed.")
            return

        sub_questions = decomposition_result.get("sub_questions", [])
        print(f"✓ Found {len(sub_questions)} sub-questions:")
        for i, q in enumerate(sub_questions, 1):
            print(f"  {i}. {q}")

        # Step 2: Get answers for sub-questions
        print("\n2. Getting answers for sub-questions...")
        sub_questions, sub_answers = MOS.get_sub_answers(
            sub_questions=sub_questions, search_engine=tree_memory, llm_config=llm_config, top_k=3
        )

        print("✓ Generated answers:")
        for i, (question, answer) in enumerate(zip(sub_questions, sub_answers, strict=False), 1):
            print(f"\n  Sub-question {i}: {question}")
            print(f"  Answer: {answer}")

        # Step 3: Generate final synthesis
        print("\n3. Generating final synthesis...")
        # Build the sub-questions and answers text
        qa_text = ""
        for i, (question, answer) in enumerate(zip(sub_questions, sub_answers, strict=False), 1):
            qa_text += f"Q{i}: {question}\nA{i}: {answer}\n\n"

        synthesis_prompt = f"""You are an expert at synthesizing information from multiple sources to provide comprehensive answers.

Sub-questions and their answers:
{qa_text}
Please synthesize these answers into a comprehensive response that:
1. Addresses the original question completely
2. Integrates information from all sub-questions
3. Provides clear reasoning and connections
4. Is well-structured and easy to understand

Original question: {complex_question}

Your response:"""

        # Generate final answer
        from memos.llms.factory import LLMFactory

        llm = LLMFactory.from_config(llm_config)
        messages = [
            {
                "role": "system",
                "content": "You are a helpful assistant that synthesizes information from multiple sources.",
            },
            {"role": "user", "content": synthesis_prompt},
        ]

        final_answer = llm.generate(messages)
        print(f"\n✓ Final synthesized answer:\n{final_answer}")

    except Exception as e:
        print(f"✗ Error in complete workflow: {e}")


def main():
    """Main function to run the CoT example."""
    print("MemOS CoT (Chain of Thought) Usage Example")
    print("=" * 60)

    # Run the examples
    cot_decompose()
    get_sub_answers_with_tree_memory()
    complete_cot_workflow()

    print("\n" + "=" * 60)
    print("✓ All examples completed successfully!")


if __name__ == "__main__":
    main()
