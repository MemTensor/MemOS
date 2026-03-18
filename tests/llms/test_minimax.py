import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import MinimaxLLMConfig
from memos.llms.minimax import MinimaxLLM


class TestMinimaxLLM(unittest.TestCase):
    def test_minimax_llm_generate_with_and_without_think_prefix(self):
        """Test MinimaxLLM generate method with and without <think> tag removal."""

        # Simulated full content including <think> tag
        full_content = "Hello from MiniMax!"
        reasoning_content = "Thinking in progress..."

        # Mock response object
        mock_response = MagicMock()
        mock_response.model_dump_json.return_value = '{"mock": "true"}'
        mock_response.choices[0].message.content = full_content
        mock_response.choices[0].message.reasoning_content = reasoning_content

        # Config with think prefix preserved
        config_with_think = MinimaxLLMConfig.model_validate(
            {
                "model_name_or_path": "MiniMax-M2.7",
                "temperature": 0.7,
                "max_tokens": 512,
                "top_p": 0.9,
                "api_key": "sk-test",
                "api_base": "https://api.minimax.io/v1",
                "remove_think_prefix": False,
            }
        )
        llm_with_think = MinimaxLLM(config_with_think)
        llm_with_think.client.chat.completions.create = MagicMock(return_value=mock_response)

        output_with_think = llm_with_think.generate([{"role": "user", "content": "Hello"}])
        self.assertEqual(output_with_think, f"<think>{reasoning_content}</think>{full_content}")

        # Config with think tag removed
        config_without_think = config_with_think.model_copy(update={"remove_think_prefix": True})
        llm_without_think = MinimaxLLM(config_without_think)
        llm_without_think.client.chat.completions.create = MagicMock(return_value=mock_response)

        output_without_think = llm_without_think.generate([{"role": "user", "content": "Hello"}])
        self.assertEqual(output_without_think, full_content)

    def test_minimax_llm_generate_stream(self):
        """Test MinimaxLLM generate_stream with content chunks."""

        def make_chunk(delta_dict):
            # Create a simulated stream chunk with delta fields
            delta = SimpleNamespace(**delta_dict)
            choice = SimpleNamespace(delta=delta)
            return SimpleNamespace(choices=[choice])

        # Simulate chunks: content only (MiniMax standard response)
        mock_stream_chunks = [
            make_chunk({"content": "Hello"}),
            make_chunk({"content": ", "}),
            make_chunk({"content": "MiniMax!"}),
        ]

        mock_chat_completions_create = MagicMock(return_value=iter(mock_stream_chunks))

        config = MinimaxLLMConfig.model_validate(
            {
                "model_name_or_path": "MiniMax-M2.7",
                "temperature": 0.7,
                "max_tokens": 512,
                "top_p": 0.9,
                "api_key": "sk-test",
                "api_base": "https://api.minimax.io/v1",
                "remove_think_prefix": False,
            }
        )
        llm = MinimaxLLM(config)
        llm.client.chat.completions.create = mock_chat_completions_create

        messages = [{"role": "user", "content": "Say hello"}]
        streamed = list(llm.generate_stream(messages))
        full_output = "".join(streamed)

        self.assertEqual(full_output, "Hello, MiniMax!")

    def test_minimax_llm_config_defaults(self):
        """Test MinimaxLLMConfig default values."""
        config = MinimaxLLMConfig.model_validate(
            {
                "model_name_or_path": "MiniMax-M2.7",
                "api_key": "sk-test",
            }
        )
        self.assertEqual(config.api_base, "https://api.minimax.io/v1")
        self.assertEqual(config.temperature, 0.7)
        self.assertEqual(config.max_tokens, 8192)

    def test_minimax_llm_config_custom_values(self):
        """Test MinimaxLLMConfig with custom values."""
        config = MinimaxLLMConfig.model_validate(
            {
                "model_name_or_path": "MiniMax-M2.7-highspeed",
                "api_key": "sk-test",
                "api_base": "https://custom.api.minimax.io/v1",
                "temperature": 0.5,
                "max_tokens": 2048,
            }
        )
        self.assertEqual(config.model_name_or_path, "MiniMax-M2.7-highspeed")
        self.assertEqual(config.api_base, "https://custom.api.minimax.io/v1")
        self.assertEqual(config.temperature, 0.5)
        self.assertEqual(config.max_tokens, 2048)
