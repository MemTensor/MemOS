---
title: Overview
---

## 1. API Introduction

The MemOS open-source project provides a high-performance REST API service built with **FastAPI**. The system follows a **Component + Handler** architecture, and core capabilities such as memory extraction, semantic search, and asynchronous scheduling are available through standard REST endpoints.

![MemOS Architecture](https://cdn.memtensor.com.cn/img/memos_run_server_success_compressed.png)
<div style="text-align: center; margin-top: 10px">Overview of the MemOS REST API service architecture</div>

### Core Capabilities

* **Multidimensional memory production**: Use `AddHandler` to process conversations, text, or documents and convert them into structured memories.
* **Physical isolation with MemCube**: Use Cube IDs to isolate data and indexes across users or knowledge bases.
* **End-to-end chat loop**: Use `ChatHandler` to orchestrate retrieval, generation, and asynchronous storage.
* **Asynchronous task scheduling**: Use the built-in `MemScheduler` engine to smooth large memory-production workloads and track task status.
* **Self-correction workflow**: Use feedback endpoints to correct or mark stored memories with natural language.

## 2. Getting Started

Integrate memory capabilities into your application with two core steps:

* [**Add Memory**](../core/add_memory.md): Use `POST /product/add` to write raw message streams into a target MemCube.
* [**Search Memory**](../core/search_memory.md): Use `POST /product/search` to retrieve relevant context from one or more Cubes by semantic similarity.

## 3. API Categories

MemOS APIs are grouped into the following categories:

* **[Core Memory](../core/add_memory.md)**: Atomic operations for creating, deleting, updating, and querying memories.
* **[Chat](../chat/chat.md)**: Streaming or full-response chat with memory augmentation.
* **[Message Management](../message/feedback.md)**: User feedback, suggestion queries, and related interaction APIs.
* **[Scheduler](../scheduler/get_status.md)**: Monitor background memory extraction tasks and queue status.
* **[Tools](../tools/check_cube.md)**: Utility APIs such as Cube existence checks and reverse memory ownership lookup.

## 4. Authentication and Context

### Authentication

In the open-source environment, every API request must include the `Authorization` header.

* **Development**: Define `API_KEY` in your local `.env` file or configuration.
* **Production**: Extend `RequestContextMiddleware` for OAuth2 or stronger identity checks.

### Request Context

* **user_id**: Required in the request body and used by handlers for identity tracking.
* **MemCube ID**: The core isolation unit in the open-source edition. Use `readable_cube_ids` or `writable_cube_ids` to precisely control physical read and write boundaries.

## 5. Next Steps

* [**System Configuration**](./configuration.md): Configure your LLM provider and vector database engine.
* [**Add Your First Memory**](../core/add_memory.md): Submit your first conversation messages through the SDK or curl.
* [**Common Error Codes**](../help/error_codes.md): Learn API status codes and how exceptions are handled.
