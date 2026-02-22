"""Example: Using TIAMAT as a lightweight memory backend for MemOS.

Demonstrates how to use TIAMAT's cloud memory API as a simple,
infrastructure-free alternative to the full MemOS stack.

Setup:
    pip install httpx

    # Get a free API key:
    curl -X POST https://memory.tiamat.live/api/keys/register \
      -H "Content-Type: application/json" \
      -d '{"agent_name": "memos-demo", "purpose": "memory connector"}'

    export TIAMAT_API_KEY="your-key"
"""

import os

from tiamat_connector import TiamatConnector


def main():
    api_key = os.environ.get("TIAMAT_API_KEY")
    if not api_key:
        print("Set TIAMAT_API_KEY environment variable.")
        print("Get a free key: POST https://memory.tiamat.live/api/keys/register")
        return

    connector = TiamatConnector(api_key=api_key, user_id="demo-user")

    # Check health
    if not connector.health():
        print("Cannot reach TIAMAT Memory API")
        return

    print("=== MemOS + TIAMAT Memory Connector ===\n")

    # Store memories
    print("Storing memories...")
    connector.add_memory(
        "User is a machine learning engineer at a startup",
        tags=["profile"],
        importance=0.9,
    )
    connector.add_memory(
        "Prefers PyTorch over TensorFlow for prototyping",
        tags=["preference", "ml"],
        importance=0.7,
    )
    connector.add_memory(
        "Working on a recommendation system using transformers",
        tags=["project", "ml"],
        importance=0.8,
    )

    # Store knowledge triples
    print("Storing knowledge triples...")
    connector.learn("user", "role", "ML engineer")
    connector.learn("user", "prefers", "PyTorch")
    connector.learn("user", "working_on", "recommendation system")

    # Search
    print("\nSearching for 'machine learning'...")
    results = connector.search("machine learning", limit=5)
    for r in results:
        print(f"  - {r.get('content', '')[:80]}")

    # Stats
    stats = connector.stats()
    print(f"\nMemory stats: {stats}")

    print("\n=== Done ===")
    print("All memories persisted at https://memory.tiamat.live")

    connector.close()


if __name__ == "__main__":
    main()
