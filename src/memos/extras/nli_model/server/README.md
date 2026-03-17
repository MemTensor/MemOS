# NLI Model Server

This directory contains the standalone server for the Natural Language Inference (NLI) model used by MemOS.

## Prerequisites

- Python 3.10+
- CUDA-capable GPU (Recommended for performance)
- `torch` and `transformers` libraries (required for the server)

## Running the Server

You can run the server using the module syntax from the project root to ensure imports work correctly.

### 1. Basic Start
```bash
python -m memos.extras.nli_model.server.serve
```

### 2. Configuration
You can configure the server by editing config.py:

-   `HOST`: The host to bind to (default: `0.0.0.0`)
-   `PORT`: The port to bind to (default: `32532`)
-   `NLI_DEVICE`: The device to run the model on.
    -   `cuda` (Default, uses cuda:0 if available, else fallback to mps/cpu)
    -   `cuda:0` (Specific GPU)
    -   `mps` (Apple Silicon)
    -   `cpu` (CPU)

## API Usage

### Compare One to Many
**POST** `/compare_one_to_many`

**Request Body:**
```json
{
  "source": "I just ate an apple.",
  "targets": [
    "I ate a fruit.",
    "I hate apples.",
    "The sky is blue."
  ]
}
```

## Testing

An end-to-end example script is provided to verify the server's functionality. This script starts the server locally and runs a client request to verify the NLI logic.

### End-to-End Test

Run the example script from the project root:

```bash
python examples/extras/nli_e2e_example.py
```

**Response:**
```json
{
  "results": [
    "Duplicate",     // Entailment
    "Contradiction", // Contradiction
    "Unrelated"      // Neutral
  ]
}
```
