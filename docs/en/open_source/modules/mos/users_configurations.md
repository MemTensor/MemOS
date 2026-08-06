---
title: MemOS Configuration Guide
desc: This document provides a comprehensive overview of all configuration fields and initialization methods across the different components in the MemOS system.
---

1. [Configuration Overview](#configuration-overview)
2. [MOS Configuration](#mos-configuration)
3. [LLM Configuration](#llm-configuration)
4. [MemReader Configuration](#memreader-configuration)
5. [MemCube Configuration](#memcube-configuration)
6. [Memory Configuration](#memory-configuration)
7. [Embedder Configuration](#embedder-configuration)
8. [Vector Database Configuration](#vector-database-configuration)
9. [Graph Database Configuration](#graph-database-configuration)
10. [Scheduler Configuration](#scheduler-configuration)
11. [Initialization Methods](#initialization-methods)
12. [Configuration Examples](#configuration-examples)

## Configuration Overview

MemOS uses a hierarchical configuration system with factory patterns for different backends. Each component has:
- A base configuration class
- Backend-specific configuration classes
- A factory class that creates the appropriate configuration based on the backend

## MOS Configuration

The main MOS configuration that orchestrates all components.

### MOSConfig Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `user_id` | str | "root" | User ID for the MOS this Config User ID will as default |
| `session_id` | str | auto-generated UUID | Session ID for the MOS |
| `chat_model` | LLMConfigFactory | required | LLM configuration for chat |
| `mem_reader` | MemReaderConfigFactory | required | MemReader configuration |
| `mem_scheduler` | SchedulerFactory | not required | Scheduler configuration |
| `max_turns_window` | int | 15 | Maximum conversation turns to keep |
| `top_k` | int | 5 | Maximum memories to retrieve per query |
| `enable_textual_memory` | bool | True | Enable textual memory |
| `enable_activation_memory` | bool | False | Enable activation memory |
| `enable_parametric_memory` | bool | False | Enable parametric memory |
| `enable_mem_scheduler` | bool | False | Enable scheduler memory |


### Example MOS Configuration

```json
{
  "user_id": "root",
  "chat_model": {
    "backend": "huggingface",
    "config": {
      "model_name_or_path": "Qwen/Qwen3-1.7B",
      "temperature": 0.1,
      "remove_think_prefix": true,
      "max_tokens": 4096
    }
  },
  "mem_reader": {
    "backend": "simple_struct",
    "config": {
      "llm": {
        "backend": "ollama",
        "config": {
          "model_name_or_path": "qwen3:0.6b",
          "temperature": 0.8,
          "max_tokens": 1024,
          "top_p": 0.9,
          "top_k": 50
        }
      },
      "embedder": {
        "backend": "ollama",
        "config": {
          "model_name_or_path": "nomic-embed-text:latest"
        }
      },
    "chunker": {
      "backend": "sentence",
      "config": {
        "tokenizer_or_token_counter": "gpt2",
        "chunk_size": 512,
        "chunk_overlap": 128,
        "min_sentences_per_chunk": 1
      }
    }
    }
  },
  "max_turns_window": 20,
  "top_k": 5,
  "enable_textual_memory": true,
  "enable_activation_memory": false,
  "enable_parametric_memory": false
}
```

## LLM Configuration

Configuration for different Large Language Model backends.

### Base LLM Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model_name_or_path` | str | required | Model name or path |
| `temperature` | float | 0.8 | Temperature for sampling |
| `max_tokens` | int | 1024 | Maximum tokens to generate |
| `top_p` | float | 0.9 | Top-p sampling parameter |
| `top_k` | int | 50 | Top-k sampling parameter |
| `remove_think_prefix` | bool | False | Remove think tags from output |

### Backend-Specific Fields

#### OpenAI LLM
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `api_key` | str | required | OpenAI API key |
| `api_base` | str | "https://api.openai.com/v1" | OpenAI API base URL |

#### Ollama LLM
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `api_base` | str | "http://localhost:11434" | Ollama API base URL |

#### HuggingFace LLM
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `do_sample` | bool | False | Use sampling vs greedy decoding |
| `add_generation_prompt` | bool | True | Apply generation template |

### Example LLM Configurations

```json
// OpenAI
{
  "backend": "openai",
  "config": {
    "model_name_or_path": "gpt-4o",
    "temperature": 0.8,
    "max_tokens": 1024,
    "top_p": 0.9,
    "top_k": 50,
    "api_key": "sk-...",
    "api_base": "https://api.openai.com/v1"
  }
}

// Ollama
{
  "backend": "ollama",
  "config": {
    "model_name_or_path": "qwen3:0.6b",
    "temperature": 0.8,
    "max_tokens": 1024,
    "top_p": 0.9,
    "top_k": 50,
    "api_base": "http://localhost:11434"
  }
}

// HuggingFace
{
  "backend": "huggingface",
  "config": {
    "model_name_or_path": "Qwen/Qwen3-1.7B",
    "temperature": 0.1,
    "remove_think_prefix": true,
    "max_tokens": 4096,
    "do_sample": false,
    "add_generation_prompt": true
  }
}
```

## MemReader Configuration

Configuration for memory reading components.

### Base MemReader Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `created_at` | datetime | auto-generated | Creation timestamp |
| `llm` | LLMConfigFactory | required | LLM configuration |
| `embedder` | EmbedderConfigFactory | required | Embedder configuration |
| `chunker` | chunkerConfigFactory | required | chunker configuration |

### Backend Types

- `simple_struct`: Structured memory reader

### Example MemReader Configuration

```json
{
  "backend": "simple_struct",
  "config": {
    "llm": {
      "backend": "ollama",
      "config": {
        "model_name_or_path": "qwen3:0.6b",
        "temperature": 0.0,
        "remove_think_prefix": true,
        "max_tokens": 8192
      }
    },
    "embedder": {
      "backend": "ollama",
      "config": {
        "model_name_or_path": "nomic-embed-text:latest"
      }
    },
    "chunker": {
      "backend": "sentence",
      "config": {
        "tokenizer_or_token_counter": "gpt2",
        "chunk_size": 512,
        "chunk_overlap": 128,
        "min_sentences_per_chunk": 1
      }
    }
  }
}
```

## MemCube Configuration

Configuration for memory cube components.

### GeneralMemCubeConfig Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `user_id` | str | "default_user" | User ID for the MemCube |
| `cube_id` | str | auto-generated UUID | Cube ID for the MemCube |
| `text_mem` | MemoryConfigFactory | required | Textual memory configuration |
| `act_mem` | MemoryConfigFactory | required | Activation memory configuration |
| `para_mem` | MemoryConfigFactory | required | Parametric memory configuration |

### Allowed Backends

- **Text Memory**: `naive_text`, `general_text`, `tree_text`, `uninitialized`
- **Activation Memory**: `kv_cache`, `uninitialized`
- **Parametric Memory**: `lora`, `uninitialized`

### Example MemCube Configuration

```json
{
  "user_id": "root",
  "cube_id": "root/mem_cube_kv_cache",
  "text_mem": {},
  "act_mem": {
    "backend": "kv_cache",
    "config": {
      "memory_filename": "activation_memory.pickle",
      "extractor_llm": {
        "backend": "huggingface",
        "config": {
          "model_name_or_path": "Qwen/Qwen3-1.7B",
          "temperature": 0.8,
          "max_tokens": 1024,
          "top_p": 0.9,
          "top_k": 50,
          "add_generation_prompt": true,
          "remove_think_prefix": false
        }
      }
    }
  },
  "para_mem": {
    "backend": "lora",
    "config": {
      "memory_filename": "parametric_memory.adapter",
      "extractor_llm": {
        "backend": "huggingface",
        "config": {
          "model_name_or_path": "Qwen/Qwen3-1.7B",
          "temperature": 0.8,
          "max_tokens": 1024,
          "top_p": 0.9,
          "top_k": 50,
          "add_generation_prompt": true,
          "remove_think_prefix": false
        }
      }
    }
  }
}
```

## Memory Configuration

Configuration for different types of memory systems.

### Base Memory Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cube_id` | str | None | Unique MemCube identifier is can be cube_name or path as default|

### Textual Memory Configurations

#### Base Text Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory_filename` | str | "textual_memory.json" | Filename for storing memories |

#### Naive Text Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | required | LLM for memory extraction |

#### General Text Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | required | LLM for memory extraction |
| `vector_db` | VectorDBConfigFactory | required | Vector database configuration |
| `embedder` | EmbedderConfigFactory | required | Embedder configuration |

#### Tree Text Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | required | LLM for memory extraction |
| `dispatcher_llm` | LLMConfigFactory | required | LLM for memory dispatching |
| `embedder` | EmbedderConfigFactory | required | Embedder configuration |
| `graph_db` | GraphDBConfigFactory | required | Graph database configuration |

### Activation Memory Configurations

#### Base Activation Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory_filename` | str | "activation_memory.pickle" | Filename for storing memories |

#### KV Cache Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | required | LLM for memory extraction (must be huggingface) |

### Parametric Memory Configurations

#### Base Parametric Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory_filename` | str | "parametric_memory.adapter" | Filename for storing memories |

#### LoRA Memory
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | required | LLM for memory extraction (must be huggingface) |

### Example Memory Configurations

```json
// Tree Text Memory
{
  "backend": "tree_text",
  "config": {
    "memory_filename": "tree_memory.json",
    "extractor_llm": {
      "backend": "ollama",
      "config": {
        "model_name_or_path": "qwen3:0.6b",
        "temperature": 0.0,
        "remove_think_prefix": true,
        "max_tokens": 8192
      }
    },
    "dispatcher_llm": {
      "backend": "ollama",
      "config": {
        "model_name_or_path": "qwen3:0.6b",
        "temperature": 0.0,
        "remove_think_prefix": true,
        "max_tokens": 8192
      }
    },
    "embedder": {
      "backend": "ollama",
      "config": {
        "model_name_or_path": "nomic-embed-text:latest"
      }
    },
    "graph_db": {
      "backend": "neo4j",
      "config": {
        "uri": "bolt://localhost:7687",
        "user": "neo4j",
        "password": "12345678",
        "db_name": "user08alice",
        "auto_create": true,
        "embedding_dimension": 768
      }
    }
  }
}
```

## Embedder Configuration

Configuration for embedding models.

### Base Embedder Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model_name_or_path` | str | required | Model name or path |
| `embedding_dims` | int | None | Number of embedding dimensions |

### Backend-Specific Fields

#### Ollama Embedder
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `api_base` | str | "http://localhost:11434" | Ollama API base URL |

#### Sentence Transformer Embedder
No additional fields beyond base configuration.

### Example Embedder Configurations

```json
// Ollama Embedder
{
  "backend": "ollama",
  "config": {
    "model_name_or_path": "nomic-embed-text:latest",
    "api_base": "http://localhost:11434"
  }
}

// Sentence Transformer Embedder
{
  "backend": "sentence_transformer",
  "config": {
    "model_name_or_path": "all-MiniLM-L6-v2",
    "embedding_dims": 384
  }
}
```

## Vector Database Configuration

Configuration for vector databases.

### Base Vector DB Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `collection_name` | str | required | Name of the collection |
| `vector_dimension` | int | None | Dimension of the vectors |
| `distance_metric` | str | None | Distance metric (cosine, euclidean, dot) |

### Qdrant Vector DB Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | str | None | Qdrant host |
| `port` | int | None | Qdrant port |
| `path` | str | None | Qdrant local path |

### Example Vector DB Configuration

```json
{
  "backend": "qdrant",
  "config": {
    "collection_name": "memories",
    "vector_dimension": 768,
    "distance_metric": "cosine",
    "path": "/path/to/qdrant"
  }
}
```

## Graph Database Configuration

Configuration for graph databases.

### Base Graph DB Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `uri` | str | required | Database URI |
| `user` | str | required | Database username |
| `password` | str | required | Database password |

### Neo4j Graph DB Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `db_name` | str | required | Target database name |
| `auto_create` | bool | False | Create DB if it doesn't exist |
| `embedding_dimension` | int | 768 | Vector embedding dimension |

### Example Graph DB Configuration

```json
{
  "backend": "neo4j",
  "config": {
    "uri": "bolt://localhost:7687",
    "user": "neo4j",
    "password": "12345678",
    "db_name": "user08alice",
    "auto_create": true,
    "embedding_dimension": 768
  }
}
```

## Scheduler Configuration

Configuration for memory scheduling systems that manage memory retrieval and activation.

### Base Scheduler Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `top_k` | int | 10 | Number of top candidates to consider in initial retrieval |
| `top_n` | int | 5 | Number of final results to return after processing |
| `enable_parallel_dispatch` | bool | True | Whether to enable parallel message processing using thread pool |
| `thread_pool_max_workers` | int | 5 | Maximum worker threads in pool (1-20) |
| `consume_interval_seconds` | int | 3 | Interval for consuming messages from queue in seconds (0-60) |

### General Scheduler Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `act_mem_update_interval` | int | 300 | Interval in seconds for updating activation memory |
| `context_window_size` | int | 5 | Size of the context window for conversation history |
| `activation_mem_size` | int | 5 | Maximum size of the activation memory |
| `act_mem_dump_path` | str | auto-generated | File path for dumping activation memory |

### Backend Types

- `general_scheduler`: Advanced scheduler with activation memory management

### Example Scheduler Configuration

```json
{
  "backend": "general_scheduler",
  "config": {
    "top_k": 10,
    "top_n": 5,
    "act_mem_update_interval": 300,
    "context_window_size": 5,
    "activation_mem_size": 1000,
    "thread_pool_max_workers": 10,
    "consume_interval_seconds": 3,
    "enable_parallel_dispatch": true
  }
}
```

## Initialization Methods

### From JSON File

```python
from memos.configs.mem_os import MOSConfig

# Load configuration from JSON file
mos_config = MOSConfig.from_json_file("path/to/config.json")
```

### From Dictionary

```python
from memos.configs.mem_os import MOSConfig

# Create configuration from dictionary
config_dict = {
    "user_id": "root",
    "chat_model": {
        "backend": "huggingface",
        "config": {
            "model_name_or_path": "Qwen/Qwen3-1.7B",
            "temperature": 0.1
        }
    }
    # ... other fields
}

mos_config = MOSConfig(**config_dict)
```

### Factory Pattern Usage

```python
from memos.configs.llm import LLMConfigFactory

# Create LLM configuration using factory
llm_config = LLMConfigFactory(
    backend="huggingface",
    config={
        "model_name_or_path": "Qwen/Qwen3-1.7B",
        "temperature": 0.1
    }
)
```

## Configuration Examples

### Complete MOS Setup

```python
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS

# Load configuration
mos_config = MOSConfig.from_json_file("examples/data/config/simple_memos_config.json")

# Initialize MOS
mos = MOS(mos_config)

# Create user and register cube
user_id = "user_123"
mos.create_user(user_id=user_id)
mos.register_mem_cube("path/to/mem_cube", user_id=user_id)

# Use MOS
response = mos.chat("Hello, how are you?", user_id=user_id)
```

### Tree Memory Configuration

```python
from memos.configs.memory import MemoryConfigFactory

# Create tree memory configuration
tree_memory_config = MemoryConfigFactory(
    backend="tree_text",
    config={
        "memory_filename": "tree_memory.json",
        "extractor_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b",
                "temperature": 0.0,
                "max_tokens": 8192
            }
        },
        "dispatcher_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b",
                "temperature": 0.0,
                "max_tokens": 8192
            }
        },
        "embedder": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "nomic-embed-text:latest"
            }
        },
        "graph_db": {
            "backend": "neo4j",
            "config": {
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "password",
                "db_name": "memories",
                "auto_create": True,
                "embedding_dimension": 768
            }
        }
    }
)
```

### Multi-Backend LLM Configuration

```python
from memos.configs.llm import LLMConfigFactory

# OpenAI configuration
openai_config = LLMConfigFactory(
    backend="openai",
    config={
        "model_name_or_path": "gpt-4o",
        "temperature": 0.8,
        "max_tokens": 1024,
        "api_key": "sk-...",
        "api_base": "https://api.openai.com/v1"
    }
)

# Ollama configuration
ollama_config = LLMConfigFactory(
    backend="ollama",
    config={
        "model_name_or_path": "qwen3:0.6b",
        "temperature": 0.8,
        "max_tokens": 1024,
        "api_base": "http://localhost:11434"
    }
)

# HuggingFace configuration
hf_config = LLMConfigFactory(
    backend="huggingface",
    config={
        "model_name_or_path": "Qwen/Qwen3-1.7B",
        "temperature": 0.1,
        "remove_think_prefix": True,
        "max_tokens": 4096,
        "do_sample": False,
        "add_generation_prompt": True
    }
)
```

This comprehensive configuration system allows for flexible and extensible setup of the MemOS system with different backends and components.
