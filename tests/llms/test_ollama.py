import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import LLMConfigFactory, OllamaLLMConfig
from memos.llms.factory import LLMFactory
from memos.llms.ollama import OllamaLLM


class TestOllamaLLM(unittest.TestCase):
    def test_llm_factory_with_mocked_ollama_backend(self):
        """Test LLMFactory with mocked Ollama backend."""
        mock_chat = MagicMock()
        mock_response = MagicMock()
        mock_response.model_dump_json.return_value = '{"model":"qwen3:0.6b","created_at":"2025-05-13T18:07:04.508998134Z","done":true,"done_reason":"stop","total_duration":348924420,"load_duration":14321072,"prompt_eval_count":16,"prompt_eval_duration":16770943,"eval_count":21,"eval_duration":317395459,"message":{"role":"assistant","content":"Hello! How are you? I\'m here to help and smile!", "thinking":"Analyzing your request...","images":null,"tool_calls":null}}'

        mock_response.message = SimpleNamespace(
            role="assistant",
            content="Hello! How are you? I'm here to help and smile!",
            thinking="Analyzing your request...",
            images=None,
            tool_calls=None,
        )
        mock_chat.return_value = mock_response

        config = LLMConfigFactory.model_validate(
            {
                "backend": "ollama",
                "config": {
                    "model_name_or_path": "qwen3:0.6b",
                    "temperature": 0.8,
                    "max_tokens": 1024,
                    "top_p": 0.9,
                    "top_k": 50,
                    "enable_thinking": True,
                },
            }
        )
        llm = LLMFactory.from_config(config)
        llm.client.chat = mock_chat
        messages = [
            {"role": "user", "content": "How are you? /no_think"},
        ]
        response = llm.generate(messages)

        self.assertEqual(
            response,
            "<think>Analyzing your request...</think>Hello! How are you? I'm here to help and smile!",
        )

    def test_ollama_llm_with_mocked_backend(self):
        """Test OllamaLLM with mocked backend."""
        mock_chat = MagicMock()
        mock_response = MagicMock()
        mock_response.model_dump_json.return_value = '{"model":"qwen3:0.6b","created_at":"2025-05-13T18:07:04.508998134Z","done":true,"done_reason":"stop","total_duration":348924420,"load_duration":14321072,"prompt_eval_count":16,"prompt_eval_duration":16770943,"eval_count":21,"eval_duration":317395459,"message":{"role":"assistant","content":"Hello! How are you? I\'m here to help and smile!","thinking":"Analyzing your request...","images":null,"tool_calls":null}}'
        mock_response.message = SimpleNamespace(
            role="assistant",
            content="Hello! How are you? I'm here to help and smile!",
            thinking="Analyzing your request...",
            images=None,
            tool_calls=None,
        )
        mock_chat.return_value = mock_response

        config = OllamaLLMConfig(
            model_name_or_path="qwen3:0.6b",
            temperature=0.8,
            max_tokens=1024,
            top_p=0.9,
            top_k=50,
        )
        ollama = OllamaLLM(config)
        ollama.client.chat = mock_chat
        messages = [
            {"role": "user", "content": "How are you? /no_think"},
        ]
        response = ollama.generate(messages)

        self.assertEqual(
            response,
            "<think>Analyzing your request...</think>Hello! How are you? I'm here to help and smile!",
        )
