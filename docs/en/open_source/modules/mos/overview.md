---
title: MemOS API Development Guide (Components & Handlers Architecture)
desc: MemOS v2.0 adopts a more modular and decoupled architecture. The legacy MOS class is deprecated; Components + Handlers is now recommended for development.
---

This architecture separates "system components" (Components) from "business logic execution" (Handlers), making the system easier to extend, test, and maintain.

## 1. Core Concepts

### 1.1 Components (Core Components)

Components are the "organs" of MemOS. They are initialized when the server starts (via `init_server()`) and reused throughout the system lifecycle.

Core components include:

#### Core Memory Components

1. **MemCube**: A memory container that isolates memories across different users and application scenarios, managing multiple memory modules in a unified way.
2. **MemReader**: A memory processor that parses user inputs (chat, documents, images) into standardized memory items that the system can persist.
3. **MemScheduler**: A background scheduler that handles asynchronous processing of memory operations—storage, indexing, and organization—supporting concurrent task execution.
4. **MemChat**: A conversation controller responsible for orchestrating the memory-augmented dialogue loop: "retrieve memory → generate response → store new memory".
5. **MemFeedback**: A memory correction engine that understands users' natural-language feedback and performs atomic-level updates to memories (correction, addition, replacement).

### 1.2 Handlers (Business Processors)

Handlers are the "brain" of MemOS. They encapsulate concrete business logic by coordinating and calling the capabilities of Components to complete user-facing tasks.

#### Core Handlers Overview

| Handler | Purpose | Key Methods |
| :--- | :--- | :--- |
| **AddHandler** | Add memories (chat / documents / text) | `handle_add_memories` |
| **SearchHandler** | Search memories (semantic retrieval) | `handle_search_memories` |
| **ChatHandler** | Chat (with memory augmentation) | `handle_chat_complete`, `handle_chat_stream` |
| **FeedbackHandler** | Feedback (correct memories / human feedback) | `handle_feedback_memories` |
| **MemoryHandler** | Manage (get details / delete) | `handle_get_memory`, `handle_delete_memories` |
| **SchedulerHandler** | Scheduling (query async task status) | `handle_scheduler_status`, `handle_scheduler_wait` |
| **SuggestionHandler** | Suggestions (generate recommended questions) | `handle_get_suggestion_queries` |

## 2. API Details

### 2.1 Initialization
Initialization is the foundation of system startup. All Handlers rely on a unified component registry and dependency-injection mechanism.

- Component loading (`init_server`): When the system starts, it initializes all core components, including the LLM, storage layers (vector DB, graph DB), scheduler, and various Memory Cubes.
- Dependency injection (`HandlerDependencies`): To ensure loose coupling and testability, all components are wrapped into a `HandlerDependencies` container. When a Handler is instantiated, it receives this container and can access needed resources—such as `naive_mem_cube`, `mem_reader`, or `feedback_server`—without duplicating initialization logic.

### 2.2 Add Memories (AddHandler)
AddHandler is the brain's "memory intake instruction", responsible for converting external information into system memories. It handles not only intake and conversion of various information types, but also automatically recognizes feedback and routes it to dedicated feedback processing.

- Core capabilities:
  - Multimodal support: Processes user conversations, documents, images, and other input types, converting them into standardized memory objects.
  - Sync and async modes: Controlled via `async_mode`. **Sync mode** ("sync"): processes immediately and blocks until completion, suitable for debugging. **Async mode** ("async"): pushes tasks to a background queue for concurrent processing by MemScheduler, returns a task ID immediately, suitable for production to improve response speed.
  - Automatic feedback routing: If the request sets `is_feedback=True`, the Handler automatically extracts the last user message as feedback content and routes it to MemFeedback processing, instead of adding it as a normal memory.
  - Multi-target writes: Supports writing to multiple MemCubes simultaneously. When multiple targets are specified, the system processes all write tasks in parallel; when only one target is specified, it uses a lightweight approach.

### 2.3 Search Memories (SearchHandler)
SearchHandler is the brain's "memory retrieval instruction", providing semantic-based intelligent memory query capabilities and serving as a key component for RAG (Retrieval-Augmented Generation).

- Core capabilities:
  - Semantic retrieval: Uses embedding technology to recall relevant memories based on semantic similarity, understanding user intent more accurately than simple keyword matching.
  - Flexible search scope: Supports specifying the target data range for retrieval. For example, you can search only within a specific user's memory, or search across multiple users' shared public memories, meeting different privacy and business needs.
  - Multiple retrieval modes: Flexibly choose between speed and accuracy based on application scenarios. **Fast mode** suits scenarios requiring high real-time performance, **fine mode** suits scenarios pursuing high retrieval accuracy, and **mixed mode** balances both.
  - Multi-step reasoning retrieval: For complex questions, supports deep reasoning capability to progressively approach the most relevant memories through multiple rounds of understanding and retrieval.

### 2.4 Chat (ChatHandler)
ChatHandler is the brain's "dialogue coordination instruction", responsible for converting user dialogue requirements into a complete business process. It does not directly operate on memories; instead, it coordinates other Handlers to complete end-to-end dialogue tasks.

- Core capabilities:
  - Orchestration: Automatically executes the complete dialogue loop of "retrieve memory → generate response → store memory". Each user query benefits from historical memories for smarter responses, and each dialogue is crystallized as new memory, achieving "chat-as-learning".
  - Context management: Handles the assembly of `history` (past conversation) and `query` (current question) to ensure the LLM understands the complete dialogue context and avoids information loss.
  - Multiple interaction modes: Supports standard request-response mode and streaming response mode. Standard mode suits simple questions, streaming mode suits long-text replies, meeting different frontend interaction needs.
  - Message push (optional): Supports automatically pushing results to third-party platforms (such as DingTalk) after generating responses, enabling multi-channel integration.

### 2.5 Feedback and Correction (FeedbackHandler)
FeedbackHandler is the brain's "feedback correction instruction", responsible for understanding users' natural-language feedback about AI performance and automatically locating and correcting relevant memory content.

- Core capabilities:
  - Memory correction: When users point out AI errors (such as "the meeting location is Shanghai, not Beijing"), the Handler automatically updates or marks old memories. The system uses version management rather than direct deletion, maintaining traceability of modification history.
  - Positive and negative feedback: Supports users marking specific memory quality through upvote or downvote. The system adjusts the memory's weight and credibility accordingly, making subsequent retrieval more accurate.
  - Precise targeting: Supports two feedback modes. One is automatic conflict detection based on dialogue history, the other allows users to directly specify memories to correct, improving feedback effectiveness and accuracy.

### 2.6 Memory Management (MemoryHandler)
MemoryHandler is the brain's "memory management instruction", providing low-level CRUD capabilities for memory data, primarily for system admin backends or data cleanup scenarios.

- Core capabilities:
  - Fine-grained management: Unlike AddHandler's business-level writes, this Handler allows fetching detailed information of a single memory or performing physical deletion by memory ID. This direct operation bypasses business logic packaging, primarily for debugging, auditing, or system cleanup.
  - Direct backend access: Some management operations need to interact directly with the underlying memory component (naive_mem_cube) to provide the most efficient and lowest-latency data operations, meeting system operations needs.

### 2.7 Scheduler Status (SchedulerHandler)
SchedulerHandler is the brain's "task monitoring instruction", responsible for tracking the real-time execution status of all async tasks in the system, allowing users to understand background task progress and results.

- Core capabilities:
  - Status tracking: Tracks real-time task status in real-time (queued, running, completed, failed). This is important for users in async mode who need to understand when tasks complete.
  - Result fetching: Provides a task result query interface. When async tasks complete, users can fetch the final execution result or error information through this interface, understanding whether operations succeeded and the reasons for failure.
  - Sync wait (debugging tool): During testing and integration testing, provides a tool to force async tasks into synchronous waits, allowing developers to debug async flows like debugging synchronous code, improving development efficiency.

### 2.8 Suggested Questions (SuggestionHandler)
SuggestionHandler is the brain's "suggestion generation instruction", predicting users' potential needs and proactively recommending related questions to help users explore system capabilities and discover topics of interest.

- Core capabilities:
  - Dual-mode generation:
    - Conversation-based suggestions: When users provide recent conversation records, the system analyzes dialogue context and infers potential follow-up topics of interest, generating 3 related recommended questions.
    - Memory-based suggestions: When there is no conversation context, the system infers user interests and status from recent memories, generating recommended questions related to the user's recent life or work. This suits dialogue initiation or topic transitions.
  - Multi-language support: Recommended questions automatically adapt to user language settings, supporting Chinese, English, and other languages, improving experience for different users.
