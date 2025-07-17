from memos.configs.llm import LLMConfigFactory, OllamaLLMConfig
from memos.llms.factory import LLMFactory
from memos.llms.ollama import OllamaLLM


# Scenario 1: Using LLMFactory with Ollama Backend
# This is the most recommended way! 🌟

config = LLMConfigFactory.model_validate(
    {
        "backend": "ollama",
        "config": {
            "model_name_or_path": "qwen3:0.6b",
            "temperature": 0.8,
            "max_tokens": 1024,
            "top_p": 0.9,
            "top_k": 50,
        },
    }
)
llm = LLMFactory.from_config(config)
messages = [
    {"role": "user", "content": "How are you? /no_think"},
]
response = llm.generate(messages)
print("Scenario 1:", response)
print("==" * 20)


# Scenario 2: Using Pydantic model directly

config = OllamaLLMConfig(
    model_name_or_path="qwen3:0.6b",
    temperature=0.8,
    max_tokens=1024,
    top_p=0.9,
    top_k=50,
)
ollama = OllamaLLM(config)
messages = [
    {"role": "user", "content": "How are you? /no_think"},
]
response = ollama.generate(messages)
print("Scenario 2:", response)
print("==" * 20)


# Scenario 3: Using LLMFactory with OpenAI Backend

config = LLMConfigFactory.model_validate(
    {
        "backend": "openai",
        "config": {
            "model_name_or_path": "gpt-4.1-nano",
            "temperature": 0.8,
            "max_tokens": 1024,
            "top_p": 0.9,
            "top_k": 50,
            "api_key": "sk-xxxx",
            "api_base": "https://api.openai.com/v1",
        },
    }
)
llm = LLMFactory.from_config(config)
messages = [
    {"role": "user", "content": "Hello, who are you"},
]
response = llm.generate(messages)
print("Scenario 3:", response)
print("==" * 20)


# Scenario 4: Using LLMFactory with Huggingface Models

config = LLMConfigFactory.model_validate(
    {
        "backend": "huggingface",
        "config": {
            "model_name_or_path": "Qwen/Qwen3-1.7B",
            "temperature": 0.8,
            "max_tokens": 1024,
            "top_p": 0.9,
            "top_k": 50,
        },
    }
)
llm = LLMFactory.from_config(config)
messages = [
    {"role": "user", "content": "Hello, who are you"},
]
response = llm.generate(messages)
print("Scenario 4:", response)
print("==" * 20)


# Scenario 5: Using LLMFactory with Qwen (DashScope Compatible API)

config = LLMConfigFactory.model_validate(
    {
        "backend": "qwen",
        "config": {
            "model_name_or_path": "qwen-plus",  # or qwen-max-2025-01-25
            "temperature": 0.7,
            "max_tokens": 1024,
            "top_p": 0.9,
            "top_k": 50,
            "api_key": "sk-xxx",
            "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        },
    }
)
llm = LLMFactory.from_config(config)
messages = [
    {"role": "user", "content": "Can you speak Chinese?"},
]
response = llm.generate(messages)
print("Scenario 5:", response)
print("==" * 20)
