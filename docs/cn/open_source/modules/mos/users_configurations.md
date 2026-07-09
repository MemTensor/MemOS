---
title: MemOS配置指南
desc: 本文档全面概述了MemOS系统中不同组件的所有配置字段和初始化方法.
---

1. [配置概述](#configuration-overview)
2. [MOS配置](#mos-configuration)
3. [LLM配置](#llm-configuration)
4. [MemReader配置](#memreader-configuration)
5. [MemCube配置](#memcube-configuration)
6. [记忆配置](#memory-configuration)
7. [嵌入器配置](#embedder-configuration)
8. [向量数据库配置](#vector-database-configuration)
9. [图数据库配置](#graph-database-configuration)
10. [调度器配置](#scheduler-configuration)
11. [初始化方法](#initialization-methods)
12. [配置样例](#configuration-examples)

## 配置概述

MemOS使用具有不同后端工厂模式的分层配置系统。每个组件都有:
- 一个基本配置类
- 特定于后端配置类
- 一个基于后端创建适当配置的工厂类

## MOS配置

用于协调所有组件的主 MOS 配置

### MOSConfig 字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `user_id` | str | "root" | MOS的用户ID，此配置用户ID将作为默认值 |
| `session_id` | str | 自动生成UUID | MOS的会话ID |
| `chat_model` | LLMConfigFactory | 必填 | LLM配置的聊天 |
| `mem_reader` | MemReaderConfigFactory | 必填 | MemReader配置 |
| `mem_scheduler` | SchedulerFactory | 非必填 | 调度器配置 |
| `max_turns_window` | int | 15 | 最大对话次数保持 |
| `top_k` | int | 5 | 每个查询要检索的最大记忆 |
| `enable_textual_memory` | bool | True | 启用明文记忆 |
| `enable_activation_memory` | bool | False | 启用激活记忆 |
| `enable_parametric_memory` | bool | False | 启用参数记忆 |
| `enable_mem_scheduler` | bool | False | 启用记忆调度 |


### MOS配置样例

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

## LLM配置

不同LLM后端的配置

### 基本的LLM字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `model_name_or_path` | str | 必填 | 模型名称或路径 |
| `temperature` | float | 0.8 | 采样温度 |
| `max_tokens` | int | 1024 | 生成最大token数 |
| `top_p` | float | 0.9 | Top-p采样参数 |
| `top_k` | int | 50 | Top-k 采样参数 |
| `remove_think_prefix` | bool | False | 从输出中移除think标签 |

### 特定后端字段

#### OpenAI LLM
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `api_key` | str | 必填 | OpenAI API key |
| `api_base` | str | "https://api.openai.com/v1" | OpenAI API base URL |

#### Ollama LLM
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `api_base` | str | "http://localhost:11434" | Ollama API base URL |

#### HuggingFace LLM
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `do_sample` | bool | False | 使用采样VS贪婪编码 |
| `add_generation_prompt` | bool | True | 应用生成模板 |

### LLM配置样例

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

## MemReader配置

记忆读取组件的配置

### 基本MemReader字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `created_at` | datetime | 自动生成 | 创建时间戳 |
| `llm` | LLMConfigFactory | 必填 | LLM配置 |
| `embedder` | EmbedderConfigFactory | 必填 | 嵌入器配置 |
| `chunker` | chunkerConfigFactory | 必填 | 块配置 |

### 后端类型

- `simple_struct`: 结构化记忆阅读器

### MemReader配置样例

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

## MemCube配置

记忆立方组件配置

### GeneralMemCubeConfig字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `user_id` | str | "default_user" | 用户IDMemCube |
| `cube_id` | str | 自动生成UUID | MemCube的立方ID |
| `text_mem` | MemoryConfigFactory | 必填 | 明文记忆配置 |
| `act_mem` | MemoryConfigFactory | 必填 | 激活记忆配置 |
| `para_mem` | MemoryConfigFactory | 必填 | 参数记忆配置 |

### 允许的后端

- **明文记忆**: `naive_text`, `general_text`, `tree_text`, `uninitialized`
- **激活记忆**: `kv_cache`, `uninitialized`
- **参数记忆**: `lora`, `uninitialized`

### MemCube配置样例

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

## 记忆配置

配置不同类型的记忆系统

### 基础记忆字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `cube_id` | str | None | 唯一的 MemCube 标识符默认可以是 cube_name 或 path|

### 明文记忆配置

#### 基础明文记忆
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `memory_filename` | str | "textual_memory.json" |  存储记忆的文件名 |

#### 纯明文记忆（仅文本）
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | 必填 | LLM用于记忆提取 |

#### 通用明文记忆（带向量索引）
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | 必填 | LLM用于记忆提取 |
| `vector_db` | VectorDBConfigFactory | 必填 | 向量数据库配置 |
| `embedder` | EmbedderConfigFactory | 必填 | 嵌入器配置 |

#### 树形明文记忆
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | 必填 | LLM用于记忆提取 |
| `dispatcher_llm` | LLMConfigFactory | 必填 | LLM用于记忆调度 |
| `embedder` | EmbedderConfigFactory | 必填 | 嵌入器配置 |
| `graph_db` | GraphDBConfigFactory | 必填 | 图数据库配置 |

### 激活记忆配置

#### 基础激活记忆
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `memory_filename` | str | "activation_memory.pickle" | 存储记忆的文件名 |

#### KV Cache记忆
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | 必填 | LLM用于记忆提取 (must be huggingface) |

### 参数记忆配置

#### 基础参数记忆
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `memory_filename` | str | "parametric_memory.adapter" | 存储记忆的文件名 |

#### LoRA记忆
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `extractor_llm` | LLMConfigFactory | 必填 | LLM用于记忆提取 (must be huggingface) |

### 记忆配置样例

```json
// 树形明文记忆
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

## 嵌入器配置

嵌入模型配置

### 基本嵌入器字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `model_name_or_path` | str | 必填 | 模型名称或路径 |
| `embedding_dims` | int | None | 嵌入维度数量 |

### 后端特定字段

#### Ollama嵌入器
| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `api_base` | str | "http://localhost:11434" | Ollama API base URL |

#### Sentence Transformer 嵌入器
除了基本配置之外没有其他字段。

### 嵌入器配置样例

```json
// Ollama 嵌入器
{
  "backend": "ollama",
  "config": {
    "model_name_or_path": "nomic-embed-text:latest",
    "api_base": "http://localhost:11434"
  }
}

// Sentence Transformer 嵌入器
{
  "backend": "sentence_transformer",
  "config": {
    "model_name_or_path": "all-MiniLM-L6-v2",
    "embedding_dims": 384
  }
}
```

## 向量数据库配置

配置向量数据库

### 基础向量数据库字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `collection_name` | str | 必填 | 集合名称 |
| `vector_dimension` | int | None | 向量维度 |
| `distance_metric` | str | None | 距离度量 (余弦, 欧式, 点积) |

### Qdrant向量数据库字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `host` | str | None | Qdrant主机 |
| `port` | int | None | Qdrant端口 |
| `path` | str | None | Qdrant本地路径 |

### 向量数据库配置示例

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

## 图数据库配置

配置图数据库

### 基础图数据库字段

| Field | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `uri` | str | 必填 | 数据库URI |
| `user` | str | 必填 | 数据库用户名 |
| `password` | str | 必填 | 数据库密码 |

### Neo4j图数据库字段

| Field | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `db_name` | str | 必填 | 目标数据库名称 |
| `auto_create` | bool | False | 如果不存在，创建数据库 |
| `embedding_dimension` | int | 768 | 向量嵌入维度 |

### 图数据库配置示例

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

## 调度器配置

用于管理记忆检索和激活的记忆调度系统的配置

### 基本调度器字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `top_k` | int | 10 | 在初始检索中要考虑的候选记忆数 |
| `top_n` | int | 5 | 处理后返回的最终结果数 |
| `enable_parallel_dispatch` | bool | True | 是否使用线程池启用并行消息处理 |
| `thread_pool_max_workers` | int | 5 | 线程池中的最大线程数(1-20) |
| `consume_interval_seconds` | int | 3 | 从队列中消费消息的间隔（以秒为单位）(0-60) |

### 通用调度器字段

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `act_mem_update_interval` | int | 300 | 更新激活记忆的时间间隔（秒） |
| `context_window_size` | int | 5 | 对话历史记录的上下文窗口的大小 |
| `activation_mem_size` | int | 5 | 激活记忆的大小 |
| `act_mem_dump_path` | str | 自动生成 | 用于激活记忆存储的文件路径 |

### 后端类型

- `general_scheduler`: 具有激活记忆管理的高级调度程序

### 调度器配置示例

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

## 初始化方法

### 来自JSON文件

```python
from memos.configs.mem_os import MOSConfig

# 从JSON文件加载配置
mos_config = MOSConfig.from_json_file("path/to/config.json")
```

### 来自字典

```python
from memos.configs.mem_os import MOSConfig

# 从字典创建配置
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

### 工厂模式用法

```python
from memos.configs.llm import LLMConfigFactory

# 使用工厂模式创建LLM配置
llm_config = LLMConfigFactory(
    backend="huggingface",
    config={
        "model_name_or_path": "Qwen/Qwen3-1.7B",
        "temperature": 0.1
    }
)
```

## 配置样例

### 创建完整MOS

```python
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS

# 加载配置
mos_config = MOSConfig.from_json_file("examples/data/config/simple_memos_config.json")

# 初始化MOS
mos = MOS(mos_config)

# 创建用户和注册立方
user_id = "user_123"
mos.create_user(user_id=user_id)
mos.register_mem_cube("path/to/mem_cube", user_id=user_id)

# 使用MOS
response = mos.chat("Hello, how are you?", user_id=user_id)
```

### 树形记忆配置

```python
from memos.configs.memory import MemoryConfigFactory

# 创建树形记忆配置
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

### 多后端LLM配置

```python
from memos.configs.llm import LLMConfigFactory

# OpenAI 配置
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

# Ollama 配置
ollama_config = LLMConfigFactory(
    backend="ollama",
    config={
        "model_name_or_path": "qwen3:0.6b",
        "temperature": 0.8,
        "max_tokens": 1024,
        "api_base": "http://localhost:11434"
    }
)

# HuggingFace 配置
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

这个全面的配置系统允许灵活和可扩展的MemOS系统设置不同的后端和组件
