"""
Textual Memory Internet Search Example
=======================================

This example demonstrates how to use MemOS's InternetRetrieverFactory to search
the web and retrieve relevant information as memory items.

**What you'll learn:**
- How to initialize an embedder for web content embedding
- How to configure and use BochaAI web search retriever
- How to chunk and process web content into memory items
- How to retrieve structured information from internet searches

**Use case:**
When you need to answer questions that require real-time web information
(e.g., "What's in Alibaba's 2024 ESG report?"), this retriever can:
1. Search the web using BochaAI API
2. Fetch and parse web page content
3. Chunk the content into manageable pieces
4. Return structured memory items with embeddings

**Prerequisites:**
- Valid BochaAI API Key (set in config file)
- Embedder service running (e.g., Ollama with nomic-embed-text)
- Internet connection for web searches

Run this example:
    python examples/basic_modules/textual_memory_internet_search_example.py
"""

import json
import os

from memos import log
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)


logger = log.get_logger(__name__)

# ============================================================================
# Step 0: Setup - Load configuration files
# ============================================================================
print("=" * 80)
print("Textual Memory Internet Search Example")
print("=" * 80)

current_dir = os.path.dirname(os.path.abspath(__file__))
config_dir = os.path.join(current_dir, "../data/config")

# Load the shared tree-text memory configuration
config_path = os.path.join(config_dir, "tree_config_shared_database.json")
with open(config_path) as f:
    config_data = json.load(f)

print(f"\n✓ Loaded configuration from: {config_path}")

# ============================================================================
# Step 1: Initialize Embedder
# ============================================================================
print("\n[Step 1] Initializing embedder for web content...")

# The embedder will convert web content into vector embeddings
embedder_config = EmbedderConfigFactory.model_validate(config_data["embedder"])
embedder = EmbedderFactory.from_config(embedder_config)

print(f"✓ Embedder initialized: {embedder_config.backend}")

# ============================================================================
# Step 2: Configure Internet Retriever (BochaAI)
# ============================================================================
print("\n[Step 2] Configuring internet retriever...")

# Load the simple_struct reader configuration
reader_config_path = os.path.join(config_dir, "simple_struct_reader_config.json")
with open(reader_config_path) as f:
    reader_config_data = json.load(f)

print(f"✓ Loaded reader configuration from: {reader_config_path}")

# NOTE: You need to set your BochaAI API key here or in environment variable
# For this example, we'll read from environment variable
bocha_api_key = os.environ.get("BOCHA_API_KEY", "sk-your-bocha-api-key-here")

if bocha_api_key == "sk-your-bocha-api-key-here":
    print("⚠️  Warning: Using placeholder API key. Set BOCHA_API_KEY environment variable.")

retriever_config = InternetRetrieverConfigFactory.model_validate(
    {
        "backend": "bocha",
        "config": {
            "api_key": bocha_api_key,
            "max_results": 5,  # Maximum number of search results to retrieve
            "reader": {
                # The reader chunks web content into memory items
                "backend": "simple_struct",
                "config": reader_config_data,  # Use loaded configuration
            },
        },
    }
)

print(f"✓ Retriever configured: {retriever_config.backend}")
print(f"  Max results per search: {retriever_config.config.max_results}")

# ============================================================================
# Step 3: Create Retriever Instance
# ============================================================================
print("\n[Step 3] Creating internet retriever instance...")

retriever = InternetRetrieverFactory.from_config(retriever_config, embedder)

print("✓ Retriever initialized and ready")

# ============================================================================
# Step 4: Perform Web Search
# ============================================================================
print("\n[Step 4] Performing web search...")

# Define the search query
query = "Alibaba 2024 ESG report"
print(f"  🔍 Query: '{query}'")
print("  ⏳ Searching the web and processing results...\n")

# Execute the search
# This will:
# 1. Search using BochaAI API
# 2. Fetch web page content
# 3. Parse and chunk the content
# 4. Generate embeddings for each chunk
# 5. Return as TextualMemoryItem objects
results = retriever.retrieve_from_internet(query)

print("✓ Search completed!")
print(f"✓ Retrieved {len(results)} memory items from web search\n")

# ============================================================================
# Step 5: Display Results
# ============================================================================
print("=" * 80)
print("WEB SEARCH RESULTS")
print("=" * 80)

if not results:
    print("\n❌ No results found.")
    print("   This might indicate:")
    print("   - Invalid or missing BochaAI API key")
    print("   - Network connectivity issues")
    print("   - The query returned no relevant web pages")
    print("   - The web content couldn't be parsed")
else:
    for idx, item in enumerate(results, 1):
        print(f"\n[Result #{idx}]")
        print("-" * 80)

        # Display the memory content (truncated for readability)
        content = item.memory
        if len(content) > 300:
            print(f"Content: {content[:300]}...")
            print(f"         (... {len(content) - 300} more characters)")
        else:
            print(f"Content: {content}")

        # Display metadata if available
        if hasattr(item, "metadata") and item.metadata:
            metadata = item.metadata
            if hasattr(metadata, "sources") and metadata.sources:
                print(f"Source: {metadata.sources[0] if metadata.sources else 'N/A'}")

        print()

print("=" * 80)
print("Example completed successfully!")
print("=" * 80)
print("\n💡 Next steps:")
print("  - Set your BochaAI API key in environment variable: export BOCHA_API_KEY='sk-...'")
print("  - Try different search queries to test various topics")
print("  - Adjust max_results in config to control number of results")
print("  - Use the retrieved memory items in your retrieval pipeline")
print("  - Combine internet search with local memory retrieval for hybrid systems\n")

print("\n⚠️  Note:")
print("  If you see 'No results found', make sure:")
print("  1. Your BochaAI API key is valid and set correctly")
print("  2. You have internet connectivity")
print("  3. The embedder service is running\n")
