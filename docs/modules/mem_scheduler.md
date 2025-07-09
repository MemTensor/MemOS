# MemScheduler: The Scheduler for Memory Organization

`MemScheduler` is a concurrent memory management system parallel running with the MemOS system, which coordinates memory operations between working memory, long-term memory, and activation memory in AI systems. It handles memory retrieval, updates, and compaction through event-driven scheduling.

This system is particularly suited for conversational agents and reasoning systems requiring dynamic memory management.


## Memory Scheduler Architecture

The `MemScheduler` system is structured around several key components:

1. **Message Handling**: Processes incoming messages through a dispatcher with labeled handlers
2. **Memory Management**: Manages different memory types (Working, Long-Term, User)
3. **Retrieval System**: Efficiently retrieves relevant memory items based on context
4. **Monitoring**: Tracks memory usage, frequencies, and triggers updates
5. **Logging**: Maintains logs of memory operations for debugging and analysis

## Message Processing

The scheduler processes messages through a dispatcher with dedicated handlers:

### Message Types

| Message Type | Handler Method                  | Description                                |
|--------------|---------------------------------|--------------------------------------------|
| `QUERY_LABEL` | `_query_message_consume`       | Handles user queries and triggers retrieval |
| `ANSWER_LABEL`| `_answer_message_consume`      | Processes answers and updates memory usage |

### Message Structure (`ScheduleMessageItem`)

| Field         | Type                 | Description                                   |
|---------------|----------------------|-----------------------------------------------|
| `item_id`     | `str`                | UUID (auto-generated) for unique identification |
| `user_id`     | `str`                | Identifier for the associated user            |
| `mem_cube_id` | `str`                | Identifier for the memory cube                |
| `label`       | `str`                | Message label (e.g., `QUERY_LABEL`, `ANSWER_LABEL`) |
| `mem_cube`    | `GeneralMemCube | str` | Memory cube object or reference               |
| `content`     | `str`                | Message content                               |
| `timestamp`   | `datetime`           | Time when the message was submitted           |

## Memory Management

### Memory Types and Sizes

The scheduler manages multiple memory partitions with configurable capacities:

| Memory Type               | Description                               | Default Capacity |
|---------------------------|------------------------------------------|------------------|
| `long_term_memory`        | Persistent knowledge storage             | 10,000 items     |
| `user_memory`             | User-specific knowledge and interactions | 10,000 items     |
| `working_memory`          | Active context for current interactions  | 20 items         |
| `transformed_act_memory`  | Transformed activation memory (dynamic)  | Not initialized  |

### Configuration Parameters

| Parameter                  | Description                                                                 | Default Value |
|----------------------------|-----------------------------------------------------------------------------|---------------|
| `top_k`                    | Number of candidates to retrieve during initial search                     | 10            |
| `top_n`                    | Number of final results to return after processing                         | 5             |
| `enable_parallel_dispatch` | Enable parallel message processing using thread pool                       | `True`        |
| `thread_pool_max_workers`  | Maximum number of worker threads in the pool                                | 5             |
| `consume_interval_seconds` | Interval (in seconds) for consuming messages from the queue                | 3             |
| `act_mem_update_interval`  | Interval (in seconds) for updating activation memory                        | 300           |
| `context_window_size`      | Size of the context window for conversation history                         | 5             |
| `activation_mem_size`      | Maximum size of the activation memory


##  Execution Example

`examples/mem_scheduler/schedule_w_memos.py` is a demonstration script showcasing how to utilize the `MemScheduler` module. It illustrates memory management and retrieval within conversational contexts.

### Code Functionality Overview

This script demonstrates two methods for initializing and using the memory scheduler:

1. **Automatic Initialization**: Configures the scheduler via configuration files
2. **Manual Initialization**: Explicitly creates and configures scheduler components

The script simulates a pet-related conversation between a user and an assistant, demonstrating how memory scheduler manages conversation history and retrieves relevant information.

### Core Code Structure

```python
def init_task():
    # Initialize sample conversations and questions
    conversations = [
        {"role": "user", "content": "I just adopted a golden retriever puppy yesterday."},
        {"role": "assistant", "content": "Congratulations! What did you name your new puppy?"},
        # More conversations...
    ]

    questions = [
        {"question": "What's my dog's name again?", "category": "Pet"},
        # More questions...
    ]
    return conversations, questions

def run_with_automatic_scheduler_init():
    # Automatic initialization: Load configuration from YAML files
    # Create user and memory cube
    # Add conversations to memory
    # Process user queries and display answers
    # Show web logs

def run_with_manual_scheduler_init():
    # Manual initialization: Explicitly create and configure scheduler components
    # Initialize MemOS, user, and memory cube
    # Manually submit messages to the scheduler
    # Process user queries and display answers
    # Show web logs

if __name__ == '__main__':
    # Run both initialization methods sequentially
    run_with_automatic_scheduler_init()
    run_with_manual_scheduler_init(
