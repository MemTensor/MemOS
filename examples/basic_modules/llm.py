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

print("Scenario 3:\n")
for chunk in llm.generate_stream(messages):
    print(chunk, end="")
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
# Note:
# This example works for any model that supports the OpenAI-compatible Chat Completion API,
# including but not limited to:
# - Qwen models: qwen-plus, qwen-max-2025-01-25
# - DeepSeek models: deepseek-chat, deepseek-coder, deepseek-v3
# - Other compatible providers: MiniMax, Fireworks, Groq, OpenRouter, etc.
#
# Just set the correct `api_key`, `api_base`, and `model_name_or_path`.

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
    {"role": "user", "content": "Hello, who are you"},
]
response = llm.generate(messages)
print("Scenario 5:", response)
print("==" * 20)

print("Scenario 5:\n")
for chunk in llm.generate_stream(messages):
    print(chunk, end="")
print("==" * 20)

# Scenario 6: Using LLMFactory with Deepseek-chat

cfg = LLMConfigFactory.model_validate(
    {
        "backend": "deepseek",
        "config": {
            "model_name_or_path": "deepseek-chat",
            "api_key": "sk-xxx",
            "api_base": "https://api.deepseek.com",
            "temperature": 0.6,
            "max_tokens": 512,
            "remove_think_prefix": False,
        },
    }
)
llm = LLMFactory.from_config(cfg)
messages = [{"role": "user", "content": "Hello, who are you"}]
resp = llm.generate(messages)
print("Scenario 6:", resp)


# Scenario 7: Using LLMFactory with Deepseek-chat + reasoning + CoT + streaming

cfg2 = LLMConfigFactory.model_validate(
    {
        "backend": "deepseek",
        "config": {
            "model_name_or_path": "deepseek-reasoner",
            "api_key": "sk-xxx",
            "api_base": "https://api.deepseek.com",
            "temperature": 0.2,
            "max_tokens": 1024,
            "remove_think_prefix": False,
        },
    }
)
llm = LLMFactory.from_config(cfg2)
messages = [
    {
        "role": "user",
        "content": "Explain how to solve this problem step-by-step. Be explicit in your thinking process. Question: If a train travels from city A to city B at 60 mph and returns at 40 mph, what is its average speed for the entire trip? Let's think step by step.",
    },
]
print("Scenario 7:\n")
for chunk in llm.generate_stream(messages):
    print(chunk, end="")
print("==" * 20)
