import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import DeepSeekLLMConfig
from memos.llms.deepseek import DeepSeekLLM


class TestDeepSeekLLM(unittest.TestCase):
    def test_deepseek_llm_generate_with_and_without_think_prefix(self):
        """Test DeepSeekLLM generate method with and without <think> tag removal."""

        # Simulated full content including <think> tag
        full_content = "Hello from DeepSeek!"
        reasoning_content = "Thinking in progress..."

        # Mock response object
        mock_response = MagicMock()
        mock_response.model_dump_json.return_value = '{"mock": "true"}'
        mock_response.choices[0].message.content = full_content
        mock_response.choices[0].message.reasoning_content = reasoning_content

        # Config with think prefix preserved
        config_with_think = DeepSeekLLMConfig.model_validate(
            {
                "model_name_or_path": "deepseek-chat",
                "temperature": 0.7,
                "max_tokens": 512,
                "top_p": 0.9,
                "api_key": "sk-test",
                "api_base": "https://api.deepseek.com/v1",
                "remove_think_prefix": False,
            }
        )
        llm_with_think = DeepSeekLLM(config_with_think)
        llm_with_think.client.chat.completions.create = MagicMock(return_value=mock_response)

        output_with_think = llm_with_think.generate([{"role": "user", "content": "Hello"}])
        self.assertEqual(output_with_think, f"<think>{reasoning_content}</think>{full_content}")

        # Config with think tag removed
        config_without_think = config_with_think.model_copy(update={"remove_think_prefix": True})
        llm_without_think = DeepSeekLLM(config_without_think)
        llm_without_think.client.chat.completions.create = MagicMock(return_value=mock_response)

        output_without_think = llm_without_think.generate([{"role": "user", "content": "Hello"}])
        self.assertEqual(output_without_think, full_content)

    def test_deepseek_llm_generate_stream(self):
        """Test DeepSeekLLM generate_stream with reasoning_content and content chunks."""

        def make_chunk(delta_dict):
            # Create a simulated stream chunk with delta fields
            delta = SimpleNamespace(**delta_dict)
            choice = SimpleNamespace(delta=delta)
            return SimpleNamespace(choices=[choice])

        # Simulate chunks: reasoning + answer
        mock_stream_chunks = [
            make_chunk({"reasoning_content": "Analyzing..."}),
            make_chunk({"content": "Hello"}),
            make_chunk({"content": ", "}),
            make_chunk({"content": "DeepSeek!"}),
        ]

        mock_chat_completions_create = MagicMock(return_value=iter(mock_stream_chunks))

        config = DeepSeekLLMConfig.model_validate(
            {
                "model_name_or_path": "deepseek-chat",
                "temperature": 0.7,
                "max_tokens": 512,
                "top_p": 0.9,
                "api_key": "sk-test",
                "api_base": "https://api.deepseek.com/v1",
                "remove_think_prefix": False,
            }
        )
        llm = DeepSeekLLM(config)
        llm.client.chat.completions.create = mock_chat_completions_create

        messages = [{"role": "user", "content": "Say hello"}]
        streamed = list(llm.generate_stream(messages))
        full_output = "".join(streamed)

        self.assertIn("Analyzing...", full_output)
        self.assertIn("Hello, DeepSeek!", full_output)
        self.assertTrue(full_output.startswith("<think>"))
        self.assertTrue(full_output.endswith("DeepSeek!"))
