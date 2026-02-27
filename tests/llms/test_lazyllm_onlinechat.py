import sys
import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import LLMConfigFactory
from memos.llms.factory import LLMFactory


class TestLazyLLMOnlineChatBackend(unittest.TestCase):
    def test_generate_with_mocked_lazyllm_backend(self):
        """Test LLMFactory with mocked lazyllm backend."""
        mock_client = MagicMock()
        mock_client.return_value = {"content": "Hello from LazyLLM", "tool_calls": None}
        mock_namespace_module = SimpleNamespace(OnlineChatModule=MagicMock(return_value=mock_client))

        mock_lazyllm = SimpleNamespace(namespace=MagicMock(return_value=mock_namespace_module))
        original_lazyllm = sys.modules.get("lazyllm")
        sys.modules["lazyllm"] = mock_lazyllm
        try:
            config = LLMConfigFactory.model_validate(
                {
                    "backend": "lazyllm",
                    "config": {
                        "model_name_or_path": "gpt-4o-mini",
                        "source": "openai",
                        "api_key": "sk-xxxx",
                        "api_base": "https://api.openai.com/v1",
                        "namespace": "memos",
                    },
                }
            )
            llm = LLMFactory.from_config(config)
            response = llm.generate([{"role": "user", "content": "hello"}])
            self.assertEqual(response, "Hello from LazyLLM")
            mock_lazyllm.namespace.assert_called_once_with("memos")
        finally:
            if original_lazyllm is None:
                sys.modules.pop("lazyllm", None)
            else:
                sys.modules["lazyllm"] = original_lazyllm

    def test_generate_with_tool_calls(self):
        """Test lazyllm tool call parser compatibility."""
        mock_client = MagicMock()
        mock_client.return_value = {
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "function": {"name": "search", "arguments": '{"query":"memos"}'},
                }
            ],
        }
        mock_namespace_module = SimpleNamespace(OnlineChatModule=MagicMock(return_value=mock_client))

        mock_lazyllm = SimpleNamespace(namespace=MagicMock(return_value=mock_namespace_module))
        original_lazyllm = sys.modules.get("lazyllm")
        sys.modules["lazyllm"] = mock_lazyllm
        try:
            config = LLMConfigFactory.model_validate(
                {
                    "backend": "lazyllm",
                    "config": {"model_name_or_path": "gpt-4o-mini"},
                }
            )
            llm = LLMFactory.from_config(config)
            response = llm.generate([{"role": "user", "content": "search memos"}])
            self.assertEqual(
                response,
                [
                    {
                        "tool_call_id": "call_1",
                        "function_name": "search",
                        "arguments": {"query": "memos"},
                    }
                ],
            )
        finally:
            if original_lazyllm is None:
                sys.modules.pop("lazyllm", None)
            else:
                sys.modules["lazyllm"] = original_lazyllm
