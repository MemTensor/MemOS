# Server API Usage Guide

This guide explains how to use the MemOS Server API for memory management operations.

## Prerequisites

Before using the Server API, ensure you have the necessary dependencies installed and environment properly configured.

## 1. Environment Configuration

Create a `.env` file in the `MemOS` directory with the following configuration parameters. These settings are used by the server router configuration defined in `MemOS/src/memos/api/routers/server_router.py`.

### Required Environment Variables

#### LLM Configuration (OpenAI)
```bash
# OpenAI API Configuration
OPENAI_API_KEY=your-api-key-here
OPENAI_API_BASE=https://api.openai.com/v1
MOS_CHAT_MODEL=gpt-4o-mini
MOS_CHAT_TEMPERATURE=0.8
MOS_MAX_TOKENS=1024
MOS_TOP_P=0.9
MOS_TOP_K=50
MOS_CHAT_MODEL_PROVIDER=openai
```

#### Embedder Configuration
```bash
# Embedder Backend: ollama or universal_api
MOS_EMBEDDER_BACKEND=ollama
MOS_EMBEDDER_MODEL=nomic-embed-text:latest
OLLAMA_API_BASE=http://localhost:11434
EMBEDDING_DIMENSION=1024

# If using universal_api embedder:
# MOS_EMBEDDER_BACKEND=universal_api
# MOS_EMBEDDER_PROVIDER=openai
# MOS_EMBEDDER_API_KEY=sk-xxxx
# MOS_EMBEDDER_MODEL=text-embedding-3-large
# MOS_EMBEDDER_API_BASE=http://openai.com
```

#### Graph Database Configuration
```bash
# Graph DB Backend: neo4j-community, neo4j, or nebular
NEO4J_BACKEND=nebular

# Neo4j Configuration (if using neo4j or neo4j-community)
# NEO4J_URI=bolt://localhost:7687
# NEO4J_USER=neo4j
# NEO4J_PASSWORD=12345678
# NEO4J_DB_NAME=neo4j
# MOS_NEO4J_SHARED_DB=false

# Nebular Configuration (if using nebular)
NEBULAR_HOSTS=["localhost"]
NEBULAR_USER=root
NEBULAR_PASSWORD=xxxxxx
NEBULAR_SPACE=shared-tree-textual-memory
```

#### Vector Database Configuration (for Neo4j Community)
```bash
# Qdrant Configuration
QDRANT_HOST=localhost
QDRANT_PORT=6333
```

#### Reranker Configuration
```bash
# Reranker Backend: http_bge or cosine_local
MOS_RERANKER_BACKEND=http_bge
MOS_RERANKER_URL=http://your-reranker-url
MOS_RERANKER_MODEL=bge-reranker-v2-m3
```

#### Optional: Internet Search Configuration
```bash
# Internet Search (optional)
ENABLE_INTERNET=false
BOCHA_API_KEY=your-bocha-api-key
```

#### Optional: Memory Reader Configuration
```bash
# Memory Reader LLM (if different from chat model)
MEMRADER_MODEL=gpt-4o-mini
MEMRADER_API_KEY=EMPTY
MEMRADER_API_BASE=https://api.openai.com/v1
```

#### Optional: Additional Settings
```bash
# Enable default cube configuration
MOS_ENABLE_DEFAULT_CUBE_CONFIG=true

# Enable memory reorganization
MOS_ENABLE_REORGANIZE=false

# Enable activation memory
ENABLE_ACTIVATION_MEMORY=false
```

### Example .env File Location
Place your `.env` file at: `MemOS/.env`

## 2. Start the Server

Navigate to the MemOS directory and start the server using uvicorn:

```bash
cd MemOS
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8002 --workers 4
```

The server will start on `http://0.0.0.0:8002`

## 3. API Usage Examples

### 3.1 Add Memories API

Use this endpoint to add conversation memories to the system.

**Endpoint:** `POST /product/add`

**Request Example:**
```bash
curl --location --request POST 'http://127.0.0.1:8002/product/add' \
--header 'Content-Type: application/json' \
--data-raw '{
    "messages": [
        {
            "role": "user",
            "content": "Where should I go for Christmas?"
        },
        {
            "role": "assistant",
            "content": "There are many places to visit during Christmas, such as the Bund and Disneyland."
        }
    ],
    "user_id": "xiaoniuma2",
    "mem_cube_id": "lichunyu2"
}'
```

**Request Parameters:**
- `messages` (array): Conversation messages to be stored as memories
  - `role` (string): Message role ("user" or "assistant")
  - `content` (string): Message content
- `user_id` (string): Unique identifier for the user
- `mem_cube_id` (string): Memory cube identifier for organizing memories
- `session_id` (string, optional): Session identifier (defaults to "default_session")

**Response:**
```json
{
    "message": "Memory added successfully",
    "data": [
        {
            "memory": "User wants to know where to go for Christmas",
            "memory_id": "uuid-generated-id",
            "memory_type": "fact"
        }
    ]
}
```

### 3.2 Search Memories API

Use this endpoint to search for relevant memories based on a query.

**Endpoint:** `POST /server/search`

**Request Example:**
```bash
curl --location --request POST 'http://127.0.0.1:8002/server/search' \
--header 'Authorization: Token mpg-7g588gVSTTKLx1sYkNv7orfqFUX4iBbZfb3xjsh3' \
--header 'Content-Type: application/json' \
--data-raw '{
    "user_id": "xiaoniuma2",
    "mem_cube_id": "lichunyu3",
    "query": "How to enjoy Christmas?"
}'
```

**Request Parameters:**
- `user_id` (string): Unique identifier for the user
- `mem_cube_id` (string): Memory cube identifier
- `query` (string): Search query text
- `session_id` (string, optional): Session identifier for filtering results
- `top_k` (integer, optional): Number of top results to return (default: 5)
- `mode` (string, optional): Search mode
- `internet_search` (boolean, optional): Enable internet search (default: false)
- `moscube` (boolean, optional): Enable moscube search (default: false)
- `chat_history` (array, optional): Chat history for context

**Response:**
```json
{
    "message": "Search completed successfully",
    "data": {
        "text_mem": [
            {
                "cube_id": "lichunyu3",
                "memories": [
                    {
                        "id": "memory-uuid",
                        "memory": "User wants to know where to go for Christmas",
                        "ref_id": "[abc123]",
                        "metadata": {
                            "memory_type": "fact",
                            "created_at": "2024-01-01T00:00:00Z"
                        }
                    }
                ]
            }
        ],
        "act_mem": [],
        "para_mem": []
    }
}
```
