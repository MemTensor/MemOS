# Mem Scheduler Beginner's Guide

Welcome to the mem_scheduler tutorial!

mem_scheduler is a system for managing memory and conversation scheduling, consisting of:
- Mem Cube: Stores and manages user memory data
- Scheduler: Coordinates memory storage and retrieval processes
- Dispatcher (Router): Trigger different memory reorganization strategies by checking messages from MemOS systems.
- Message Queue Hub: Central communication backbone

Memory Scheduler is built to optimize memory when MemOS is running. Here are two approaches to initializing Memory Scheduler with MemOS.

An example code can be found in ```examples/mem_scheduler/schedule_w_memos.py```

## Configs for Initialization

Below is an example YAML configuration. You can find this in  ```examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml```

```
user_id: "root"
chat_model:
  backend: "huggingface"
  config:
    model_name_or_path: "Qwen/Qwen3-1.7B"
    temperature: 0.1
    remove_think_prefix: true
    max_tokens: 4096
mem_reader:
  backend: "simple_struct"
  config:
    llm:
      backend: "ollama"
      config:
        model_name_or_path: "qwen3:0.6b"
        remove_think_prefix: true
        temperature: 0.8
        max_tokens: 1024
        top_p: 0.9
        top_k: 50
    embedder:
      backend: "ollama"
      config:
        model_name_or_path: "nomic-embed-text:latest"
    chunker:
      backend: "sentence"
      config:
        tokenizer_or_token_counter: "gpt2"
        chunk_size: 512
        chunk_overlap: 128
        min_sentences_per_chunk: 1
mem_scheduler:
  backend: "general_scheduler"
  config:
    top_k: 10
    top_n: 5
    act_mem_update_interval: 300
    context_window_size: 5
    activation_mem_size: 1000
    thread_pool_max_workers: 10
    consume_interval_seconds: 3
    enable_parallel_dispatch: true
max_turns_window: 20
top_k: 5
enable_textual_memory: true
enable_activation_memory: true
enable_parametric_memory: false
enable_mem_scheduler: true
```
## Steps to Initialize with MemOS

### 1. Load config and initialize MOS
```
config = parse_yaml("./examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml")
mos_config = MOSConfig(**config)
mos = MOS(mos_config)
```
### 2. Create a User
```
user_id = "user_1"
mos.create_user(user_id)
```
### 3. Create and Register a Memory Cube
```
config = GeneralMemCubeConfig.from_yaml_file("mem_cube_config.yaml")
mem_cube_id = "mem_cube_5"
mem_cube = GeneralMemCube(config)
mem_cube.dump(mem_cube_name_or_path)
mos.register_mem_cube(mem_cube_name_or_path, mem_cube_id, user_id)
```

## Run with MemOS

### 4. Add Conversations (transformed to memories) to Memory Cube
```
mos.add(conversations, user_id=user_id, mem_cube_id=mem_cube_id)
```

### 5. Scheduler with the chat function of MemOS
```
for item in questions:
    query = item["question"]
    response = mos.chat(query, user_id=user_id)
    print(f"Query:\n {query}\n\nAnswer:\n {response}")
```
### 6. Display Logs and Stop the Scheduler
```
show_web_logs(mos.mem_scheduler)
mos.mem_scheduler.stop()
```

## Check the Scheduling Info

This guide provides a foundational understanding of setting up and using mem_scheduler. Explore and modify configurations to suit your needs!
