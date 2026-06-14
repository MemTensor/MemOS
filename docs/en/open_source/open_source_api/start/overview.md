---
title: Overview
---

## 1. API Introduction

The MemOS open-source project provides a high-performance REST API service built with **FastAPI**. The system adopts a **Component + Handler** architecture, where all core logic (such as memory extraction, semantic search, and asynchronous scheduling) can be invoked through standard REST endpoints.

![MemOS Architecture](https://cdn.memtensor.com.cn/img/memos_run_server_success_compressed.png)
<div style="text-align: center; margin-top: 10px">MemOS REST API Service Architecture Overview</div>

### Core Features

* **Multi-dimensional Memory Production**: Supports processing conversations, text, or documents via `AddHandler` and automatically converting them into structured memory.
* **MemCube Physical Isolation**: Achieves physical data isolation and independent indexing between different users or knowledge bases based on Cube ID.
* **End-to-End Dialogue Loop**: Orchestrate the full "retrieve -> generate -> async store" pipeline via the `ChatHandler`.
* **Asynchronous Task Scheduling**: Built-in `MemScheduler` engine for peak load leveling and status tracking of large-scale memory production tasks.
* **Self-Correction Mechanism**: Feedback interfaces that allow correcting or tagging stored memories using natural language.

## 2. Getting Started

Follow these two core steps to quickly integrate memory capabilities into your AI application:

* [**Add Memory**](../core/add_memory.md): Write raw message streams to a specified MemCube via the `POST /product/add` endpoint to start the production pipeline.
* [**Search Memory**](../core/search_memory.md): Retrieve relevant context from multiple Cubes via the `POST /product/search` endpoint based on semantic similarity.

## 3. API Categories

The MemOS functional APIs are organized into the following categories:

* **[Core Memory](../core/add_memory.md)**: Atomic operations for creating, reading, updating, and deleting memories.
* **[Chat](../chat/chat.md)**: Memory-augmented streaming and full-response dialogue capabilities.
* **[Message](../message/feedback.md)**: Enhanced interaction interfaces including user feedback and suggestions.
* **[Scheduler](../scheduler/get_status.md)**: Monitor the progress and queue status of background memory extraction tasks.
* **[Tools](../tools/check_cube.md)**: Auxiliary functions such as Cube existence verification and memory ownership lookup.

## 4. Authentication & Context

### Authentication Mechanism
In the open-source environment, all API requests must include the `Authorization` header.
* **Development Environment**: You can customize the `API_KEY` in your local `.env` or `configuration.md`.
* **Production Deployment**: It is recommended to extend OAuth2 or more advanced identity verification logic via `RequestContextMiddleware`.

### Request Context
* **user_id**: This identifier must be included in the request body for identity tracking at the Handler layer.
* **MemCube ID**: The core isolation unit in the open-source version. By specifying `readable_cube_ids` or `writable_cube_ids`, you can precisely control the physical boundaries of data reads and writes.

## 5. Next Steps

* 👉 [**System Configuration**](./configuration.md): Configure your LLM provider and vector database engine.
* 👉 [**Add Your First Memory**](../core/add_memory.md): Try submitting your first conversation messages via SDK or Curl.
* 👉 [**Explore Common Errors**](../help/error_codes.md): Learn about API status codes and their underlying error handling mechanisms.
