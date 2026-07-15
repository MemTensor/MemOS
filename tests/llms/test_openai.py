import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import LLMConfigFactory
from memos.llms.factory import LLMFactory


class TestLLMFactoryWithOpenAIBackend(unittest.TestCase):
    def test_llm_factory_with_mocked_openai_backend(self):
        """Test LLMFactory with mocked OpenAI backend."""
        mock_chat_completions_create = MagicMock()
        mock_response = MagicMock()
        mock_response.model_dump_json.return_value = '{"id":"chatcmpl-BWoqIrvOeWdnFVZQUFzCcdVEpJ166","choices":[{"finish_reason":"stop","index":0,"message":{"content":"Hello! I\'m an AI language model created by OpenAI. I\'m here to help answer questions, provide information, and assist with a wide range of topics. How can I assist you today?","role":"assistant"}}],"created":1747161634,"model":"gpt-4o-2024-08-06","object":"chat.completion"}'
        mock_response.choices[0].message.content = "Hello! I'm an AI language model created by OpenAI. I'm here to help answer questions, provide information, and assist with a wide range of topics. How can I assist you today?"  # fmt: skip
        mock_response.choices[0].message.reasoning_content = None
        mock_chat_completions_create.return_value = mock_response

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
        llm.client.chat.completions.create = mock_chat_completions_create
        messages = [
            {"role": "user", "content": "Hello, who are you"},
        ]
        response = llm.generate(messages)

        self.assertEqual(
            response,
            "Hello! I'm an AI language model created by OpenAI. I'm here to help answer questions, provide information, and assist with a wide range of topics. How can I assist you today?",
        )

    def test_llm_factory_with_stream_openai_backend(self):
        """Test LLMFactory stream generation with mocked OpenAI backend."""

        def make_chunk(delta_dict):
            # Create a mock response chunk with a simulated delta dictionary
            delta = SimpleNamespace(**delta_dict)
            choice = SimpleNamespace(delta=delta, finish_reason="stop", index=0)
            return SimpleNamespace(choices=[choice])

        # Simulate a stream response with both reasoning_content and content
        mock_stream_chunks = [
            make_chunk({"reasoning_content": "I am thinking"}),
            make_chunk({"content": "Hello"}),
            make_chunk({"content": ", "}),
            make_chunk({"content": "world!"}),
        ]

        # Mock the streaming chat completion call
        mock_chat_completions_create = MagicMock(return_value=iter(mock_stream_chunks))

        # Create the LLM config with think prefix enabled
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
                    "remove_think_prefix": False,
                    # Ensure <think> tag is emitted
                },
            }
        )

        # Instantiate the LLM and inject the mocked stream method
        llm = LLMFactory.from_config(config)
        llm.client.chat.completions.create = mock_chat_completions_create

        # Input message to the model
        messages = [{"role": "user", "content": "Think and say hello"}]

        # Collect streamed output as a list of chunks
        response_parts = list(llm.generate_stream(messages))
        response = "".join(response_parts)

        # Assert the presence of the <think> tag and expected content
        self.assertIn("<think>", response)
        self.assertIn("I am thinking", response)
        self.assertIn("Hello, world!", response)

        # Optional: check structure of stream response
        self.assertEqual(response_parts[0], "<think>")
        self.assertTrue(response.startswith("<think>I am thinking"))
        self.assertTrue(response.endswith("Hello, world!"))
