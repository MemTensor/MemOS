# MemReader Examples

This directory contains examples and sample code demonstrating how to use the `MemReader` module in MemOS. `MemReader` is responsible for parsing various types of input data (text, chat history, files, images) into structured memory formats.

## 📂 Directory Structure

```text
examples/mem_reader/
├── builders.py          # Factory functions to initialize Reader components
├── parser_demos/        # Demos for individual parser components
│   ├── demo_image.py    # Example: Parsing image content
│   ├── demo_string.py   # Example: Parsing string content
│   └── ...              # Other specific parser demos
├── runners/             # Main execution scripts for running examples
│   ├── run_simple.py    # Runner for SimpleStructMemReader
│   └── run_multimodal.py# Runner for MultiModalStructMemReader
├── samples.py           # Sample data (chat logs, test cases)
├── settings.py          # Configuration management (loads from .env)
└── utils.py             # Utility functions (printing, formatting)
```

## 🚀 Getting Started

### 1. Configuration

Before running the examples, ensure you have configured your environment variables. Copy the `.env.example` file in the project root to `.env` and fill in the necessary API keys.

The `settings.py` file loads these configurations. Key variables include:
- `OPENAI_API_KEY`: For LLM and Embeddings.
- `MOS_CHAT_MODEL`: Default model for chat (e.g., `gpt-4o`).
- `MOS_EMBEDDER_MODEL`: Model for embeddings.

### 2. Running Examples

We provide two main runners to demonstrate different capabilities:

#### A. Simple Reader (`run_simple.py`)

Demonstrates the `SimpleStructMemReader`, which is optimized for text-based chat history and documents.

**Features:**
- **Fast Mode**: Quick parsing without LLM (regex/rule-based).
- **Fine Mode**: Detailed parsing using LLM.
- **Transfer**: Converting Fast memories to Fine memories.
- **Document Parsing**: Reading text files.

**Usage:**
```bash
python -m examples.mem_reader.runners.run_simple
```

#### B. Multimodal Reader (`run_multimodal.py`)

Demonstrates the `MultiModalStructMemReader`, which handles complex inputs like images, files, and mixed content types.

**Features:**
- Supports **String**, **Multimodal**, and **Raw** input types.
- Configurable output format (Text/JSON).
- Selectable test cases.

**Usage:**
```bash
# Run all examples in 'fine' mode
python -m examples.mem_reader.runners.run_multimodal --example all --mode fine

# Run specific example (e.g., multimodal inputs)
python -m examples.mem_reader.runners.run_multimodal --example multimodal

# View help for more options
python -m examples.mem_reader.runners.run_multimodal --help
```

### 3. Parser Demos

If you want to understand how specific parsers work internally (e.g., how the system parses a User message vs. an Assistant message), check the `parser_demos/` directory.

**Usage:**
```bash
python -m examples.mem_reader.parser_demos.demo_user
python -m examples.mem_reader.parser_demos.demo_image
```

## 🧩 Key Components

- **`SimpleStructMemReader`**: Best for standard text-based chat applications. It's lightweight and efficient.
- **`MultiModalStructMemReader`**: Designed for advanced agents that handle images, file attachments, and complex tool interactions.

## 🛠️ Customization

You can modify `settings.py` or `builders.py` to change the underlying LLM backend (e.g., switching from OpenAI to Ollama) or adjust chunking strategies.
