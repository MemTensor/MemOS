import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import QwenLLMConfig
from memos.llms.qwen import QwenLLM


class TestQwenLLM(unittest.TestCase):
    def test_qwen_llm_generate_with_and_without_think_prefix(self):
        """Test QwenLLM non-streaming response generation with and without <think> prefix removal."""

        # Simulated full response content with <think> tag
        full_content = "Hello from DeepSeek!"
        reasoning_content = "Thinking in progress..."

        # Prepare the mock response object with expected structure
        mock_response = MagicMock()
        mock_response.model_dump_json.return_value = '{"mocked": "true"}'
        mock_response.choices[0].message.content = full_content
        mock_response.choices[0].message.reasoning_content = reasoning_content

        # Create config with remove_think_prefix = False
        config_with_think = QwenLLMConfig.model_validate(
            {
                "model_name_or_path": "qwen-test",
                "temperature": 0.7,
                "max_tokens": 100,
                "top_p": 0.9,
                "api_key": "sk-test",
                "api_base": "https://dashscope.aliyuncs.com/api/v1",
                "remove_think_prefix": False,
            }
        )

        # Instance with think tag enabled
        llm_with_think = QwenLLM(config_with_think)
        llm_with_think.client.chat.completions.create = MagicMock(return_value=mock_response)

        response_with_think = llm_with_think.generate([{"role": "user", "content": "Hi"}])
        self.assertEqual(response_with_think, f"<think>{reasoning_content}</think>{full_content}")

        # Create config with remove_think_prefix = True
        config_without_think = config_with_think.model_copy(update={"remove_think_prefix": True})

        # Instance with think tag removed
        llm_without_think = QwenLLM(config_without_think)
        llm_without_think.client.chat.completions.create = MagicMock(return_value=mock_response)

        response_without_think = llm_without_think.generate([{"role": "user", "content": "Hi"}])
        self.assertEqual(response_without_think, full_content)
        self.assertNotIn("<think>", response_without_think)

    def test_qwen_llm_generate_stream(self):
        """Test QwenLLM stream generation with both reasoning_content and content."""

        def make_chunk(delta_dict):
            # Construct a mock chunk with delta fields
            delta = SimpleNamespace(**delta_dict)
            choice = SimpleNamespace(delta=delta)
            return SimpleNamespace(choices=[choice])

        # Simulate a sequence of streamed chunks
        mock_stream_chunks = [
            make_chunk({"reasoning_content": "Analyzing input..."}),
            make_chunk({"content": "Hello"}),
            make_chunk({"content": ", "}),
            make_chunk({"content": "world!"}),
        ]

        # Mock the client's streaming response
        mock_chat_completions_create = MagicMock(return_value=iter(mock_stream_chunks))

        # Build QwenLLM config with think prefix enabled
        config = QwenLLMConfig.model_validate(
            {
                "model_name_or_path": "qwen-test",
                "temperature": 0.7,
                "max_tokens": 100,
                "top_p": 0.9,
                "api_key": "sk-test",
                "api_base": "https://dashscope.aliyuncs.com/api/v1",
                "remove_think_prefix": False,
            }
        )

        # Create QwenLLM instance and inject mock client
        llm = QwenLLM(config)
        llm.client.chat.completions.create = mock_chat_completions_create

        messages = [{"role": "user", "content": "Say hello"}]

        # Collect the streamed output
        response_parts = list(llm.generate_stream(messages))
        response = "".join(response_parts)

        # Assertions for structure and content
        self.assertIn("<think>", response)
        self.assertIn("Analyzing input...", response)
        self.assertIn("Hello, world!", response)
        self.assertTrue(response.startswith("<think>Analyzing input..."))
        self.assertTrue(response.endswith("Hello, world!"))
