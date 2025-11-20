"""
Example usage of DeepSearchAgent in MemOS.

This example demonstrates how to initialize and use the DeepSearchAgent
for comprehensive information retrieval and synthesis.
"""

from memos.configs.mem_agent import DeepSearchAgentConfig
from memos.mem_agent.deepsearch_agent import DeepSearchAgent
from memos.llms.factory import LLMFactory
from memos.configs.llm import LLMConfigFactory


def main():
    """Example usage of DeepSearchAgent."""
    
    # 1. Configure the LLM
    llm_config = LLMConfigFactory(
        backend="openai",  # or "ollama", "azure", etc.
        config={
            "api_key": "your-api-key-here",
            "model_name_or_path": "gpt-4",
            "temperature": 0.7,
            "max_tokens": 2048
        }
    )
    
    # 2. Create LLM instance
    llm = LLMFactory.from_config(llm_config)
    
    # 3. Configure DeepSearchAgent
    agent_config = DeepSearchAgentConfig(
        agent_name="DeepSearchAgent",
        description="Advanced deep search agent for comprehensive information retrieval",
        max_iterations=3,
        timeout=60
    )
    
    # 4. Create DeepSearchAgent instance
    agent = DeepSearchAgent(agent_config)
    
    # 5. Initialize the agent with LLM
    agent.set_llm(llm)
    
    # 6. Set up memory retriever (this would typically be injected by the framework)
    # agent.set_memory_retriever(your_memory_retriever)
    
    # 7. Example queries
    queries = [
        "What are the latest developments in AI research?",
        "Tell me about my recent project meetings and their outcomes",
        "What are the key trends in machine learning this year?"
    ]
    
    # 8. Process queries
    for query in queries:
        print(f"\n{'='*60}")
        print(f"Query: {query}")
        print(f"{'='*60}")
        
        try:
            # Run the deep search pipeline
            response = agent.run(
                input=query,
                history=["Previous conversation context"],
                user_id="example_user"
            )
            
            print(f"Response: {response}")
            
        except Exception as e:
            print(f"Error processing query: {e}")


if __name__ == "__main__":
    main()
