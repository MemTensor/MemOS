import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import NovitaLLMConfig
from memos.llms.novita import NovitaLLM


class TestNovitaLLM(unittest.TestCase):
    def test_novita_llm_generate(self):
        """Test NovitaLLM generate method."""

        # Simulated response content
        full_content = "Hello from Novita AI!"

        # Mock response object
        mock_response = MagicMock()
        mock_response.model_dump_json.return_value = '{"mock": "true"}'
        mock_response.choices[0].message.content = full_content

        # Config
        config = NovitaLLMConfig.model_validate(
            {
                "model_name_or_path": "moonshotai/kimi-k2.5",
                "temperature": 0.7,
                "max_tokens": 512,
                "top_p": 0.9,
                "api_key": "sk-test",
                "remove_think_prefix": False,
            }
        )
        llm = NovitaLLM(config)
        llm.client.chat.completions.create = MagicMock(return_value=mock_response)

        output = llm.generate([{"role": "user", "content": "Hello"}])
        self.assertEqual(output, full_content)

    def test_novita_llm_generate_stream(self):
        """Test NovitaLLM generate_stream method."""

        def make_chunk(delta_dict):
            delta = SimpleNamespace(**delta_dict)
            choice = SimpleNamespace(delta=delta)
            return SimpleNamespace(choices=[choice])

        # Simulate chunks
        mock_stream_chunks = [
            make_chunk({"content": "Hello"}),
            make_chunk({"content": ", "}),
            make_chunk({"content": "Novita!"}),
        ]

        mock_chat_completions_create = MagicMock(return_value=iter(mock_stream_chunks))

        config = NovitaLLMConfig.model_validate(
            {
                "model_name_or_path": "moonshotai/kimi-k2.5",
                "temperature": 0.7,
                "max_tokens": 512,
                "top_p": 0.9,
                "api_key": "sk-test",
                "remove_think_prefix": False,
            }
        )
        llm = NovitaLLM(config)
        llm.client.chat.completions.create = mock_chat_completions_create

        messages = [{"role": "user", "content": "Say hello"}]
        streamed = list(llm.generate_stream(messages))
        full_output = "".join(streamed)

        self.assertIn("Hello, Novita!", full_output)
