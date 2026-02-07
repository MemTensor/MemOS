import logging
import os
import sys


logging.basicConfig(level=logging.INFO)

# Ensure /app/src is in path
sys.path.append("/app/src")

# --- Test PolarDBGraphDB ---
try:
    print("\n[Test 1] Testing PolarDBGraphDB...")
    # Import from graph_dbs.polardb
    # Class name is PolarDBGraphDB
    from memos.configs.graph_db import PolarDBConfig
    from memos.graph_dbs.polardb import PolarDBGraphDB
    print("Successfully imported PolarDBGraphDB")
except ImportError as e:
    print(f"Failed to import PolarDBGraphDB: {e}")
    sys.exit(1)

# Credentials from docker inspect
config = PolarDBConfig(
    host="postgres",
    port=5432,
    user="memos",
    password="K2DscvW8JoBmSpEV4WIM856E6XtVl0s", 
    db_name="memos",
    auto_create=False,
    use_multi_db=False, # Shared DB mode usually
    user_name="memos_default"
)

try:
    print("Initializing PolarDBGraphDB...")
    db = PolarDBGraphDB(config)
    print("Initialized.")
    
    print("Checking connection (via simple query)...")
    # node_not_exist uses agtype_access_operator
    count = db.node_not_exist("memo")
    print(f"node_not_exist result: {count}")
    
    # Try get_node
    node = db.get_node("dummy_id_12345")
    print(f"get_node result: {node}")

    print("SUCCESS: PolarDBGraphDB test passed.")
    
except Exception as e:
    print(f"FAILURE PolarDBGraphDB: {e}")
    import traceback
    traceback.print_exc()


# --- Test Embedder ---
print("\n[Test 2] Testing UniversalAPIEmbedder (VoyageAI)...")
try:
    from memos.configs.embedder import UniversalAPIEmbedderConfig
    from memos.embedders.universal_api import UniversalAPIEmbedder
    print("Successfully imported UniversalAPIEmbedder")
    
    # Values from our api_config.py logic
    # api_config.py defaults for voyageai:
    # provider="openai"
    # base_url="https://api.voyageai.com/v1" 
    # api_key="pa-7v..." (VOYAGE_API_KEY from env)
    
    # We need to manually set these or load from env
    # Env var VOYAGE_API_KEY should be present in container
    voyage_key = os.getenv("VOYAGE_API_KEY", "missing_key")
    
    embedder_config = UniversalAPIEmbedderConfig(
        provider="openai",
        api_key=voyage_key, 
        base_url="https://api.voyageai.com/v1",
        model_name_or_path="voyage-4-lite"
    )
    
    print(f"Initializing Embedder with Base URL: {embedder_config.base_url}")
    embedder = UniversalAPIEmbedder(embedder_config)
    
    print("Generating embedding for 'Hellos World'...")
    # embed method returns list[list[float]]
    embeddings = embedder.embed(["Hellos World"])
    
    print(f"Embeddings generated. Count: {len(embeddings)}")
    if len(embeddings) > 0:
        print(f"Embedding vector length: {len(embeddings[0])}")
        print("SUCCESS: Embedder test passed.")
    else:
        print("FAILURE: No embeddings returned.")

except Exception as e:
    print(f"FAILURE Embedder: {e}")
    import traceback
    traceback.print_exc()
