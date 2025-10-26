import unittest

from unittest.mock import MagicMock, patch

import torch

from transformers import DynamicCache

from memos.configs.llm import HFLLMConfig, LLMConfigFactory
from memos.llms.factory import LLMFactory
from memos.llms.hf import HFLLM


@patch("memos.llms.hf.AutoModelForCausalLM", MagicMock())
@patch("memos.llms.hf.AutoTokenizer", MagicMock())
class TestHFLLM(unittest.TestCase):
    def setUp(self):
        self.mock_inputs = MagicMock()
        self.mock_inputs.to.return_value = self.mock_inputs
        self.mock_inputs.input_ids = torch.tensor([[1, 2, 3]])
        self.mock_tokenizer = MagicMock()
        self.standard_response = "Hello! How are you? I'm here to help and smile!"
        self.mock_tokenizer.apply_chat_template.return_value = (
            "You are Qwen, created by Alibaba Cloud. You are a helpful assistant."
        )
        self.mock_tokenizer.batch_decode.return_value = [self.standard_response]
        self.mock_tokenizer.decode = MagicMock(return_value=self.standard_response)
        self.mock_tokenizer.eos_token_id = 2
        self.mock_tokenizer.return_value = self.mock_inputs
        self.mock_model = MagicMock()
        self.mock_model.device = "cpu"
        self.mock_model.generate.return_value = torch.tensor([[1, 2, 3, 4, 5, 6]])
        forward_output = MagicMock()
        forward_output.logits = torch.ones(1, 1, 100)
        forward_output.past_key_values = DynamicCache()
        self.mock_model.return_value = forward_output

    def _create_llm(self, config):
        llm = HFLLM(config)
        llm.model = self.mock_model
        llm.tokenizer = self.mock_tokenizer
        return llm

    def test_llm_factory_with_mocked_hf_backend(self):
        config = LLMConfigFactory.model_validate(
            {
                "backend": "huggingface",
                "config": {
                    "model_name_or_path": "qwen3:0.6b",
                    "temperature": 0.8,
                    "max_tokens": 1024,
                    "top_p": 0.9,
                    "top_k": 50,
                    "add_generation_prompt": True,
                    "remove_think_prefix": False,
                },
            }
        )
        llm = LLMFactory.from_config(config)
        llm.model = self.mock_model
        llm.tokenizer = self.mock_tokenizer
        response = llm.generate([{"role": "user", "content": "How are you?"}])
        self.assertEqual(response, self.standard_response)
        self.mock_model.generate.assert_called()

    def test_standard_generation(self):
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            temperature=0.8,
            max_tokens=1024,
            top_p=0.9,
            top_k=50,
            do_sample=True,
            add_generation_prompt=True,
            remove_think_prefix=False,
        )
        llm = self._create_llm(config)
        resp = llm.generate([{"role": "user", "content": "Hello"}])
        self.assertEqual(resp, self.standard_response)
        self.assertTrue(self.mock_model.generate.call_count > 0)
        kwargs = self.mock_model.generate.call_args_list[-1][1]
        self.assertTrue(kwargs["do_sample"])
        self.assertEqual(kwargs["temperature"], 0.8)
        self.assertEqual(kwargs["max_new_tokens"], 1024)
        self.assertEqual(kwargs["top_p"], 0.9)
        self.assertEqual(kwargs["top_k"], 50)

    def test_build_kv_cache_and_generation(self):
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            temperature=0.8,
            max_tokens=10,
            add_generation_prompt=True,
        )
        llm = self._create_llm(config)

        # Ensure the mock model returns an object with past_key_values attribute
        forward_output = MagicMock()
        forward_output.logits = torch.ones(1, 1, 100)

        # Create a DynamicCache that's compatible with both old and new transformers versions
        kv_cache = DynamicCache()

        # Mock the DynamicCache to have both old and new version attributes for compatibility
        # New version uses 'layers' attribute
        mock_layer = MagicMock()
        mock_layer.key_cache = torch.tensor([[[[1.0, 2.0]]]])
        mock_layer.value_cache = torch.tensor([[[[3.0, 4.0]]]])
        kv_cache.layers = [mock_layer]

        # Old version uses 'key_cache' and 'value_cache' lists
        kv_cache.key_cache = [torch.tensor([[[[1.0, 2.0]]]])]
        kv_cache.value_cache = [torch.tensor([[[[3.0, 4.0]]]])]

        forward_output.past_key_values = kv_cache
        # Make sure the mock model call returns the forward_output when called with **kwargs
        self.mock_model.return_value = forward_output

        kv_cache = llm.build_kv_cache("The capital of France is Paris.")
        self.assertIsInstance(kv_cache, DynamicCache)
        resp = llm.generate(
            [{"role": "user", "content": "What's its population?"}], past_key_values=kv_cache
        )
        self.assertEqual(resp, self.standard_response)
        # Check that the model was called with past_key_values during _prefill
        # The model should be called multiple times during generation with cache
        found_past_key_values = False
        for call_args in self.mock_model.call_args_list:
            if len(call_args) > 1 and "past_key_values" in call_args[1]:
                found_past_key_values = True
                break
        self.assertTrue(found_past_key_values, "Model should be called with past_key_values")
        # Check that use_cache was used
        found_use_cache = False
        for call_args in self.mock_model.call_args_list:
            if len(call_args) > 1 and call_args[1].get("use_cache"):
                found_use_cache = True
                break
        self.assertTrue(found_use_cache, "Model should be called with use_cache=True")

    def test_think_prefix_removal(self):
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            temperature=0.5,
            max_tokens=100,
            add_generation_prompt=True,
            remove_think_prefix=True,
        )
        llm = self._create_llm(config)
        self.mock_tokenizer.batch_decode.return_value = ["<think>Let me think.</think>Hello World!"]
        resp = llm.generate([{"role": "user", "content": "Test"}])
        self.assertEqual(resp, "Hello World!")
        self.mock_model.generate.assert_called()

    def test_kv_cache_generation_greedy(self):
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            max_tokens=20,
            do_sample=False,
            add_generation_prompt=True,
        )
        llm = self._create_llm(config)
        kv_cache = DynamicCache()
        resp = llm.generate([{"role": "user", "content": "Greedy"}], past_key_values=kv_cache)
        self.assertEqual(resp, self.standard_response)

    def test_kv_cache_generation_with_sampling(self):
        forward_output = MagicMock()
        forward_output.logits = torch.randn(1, 1, 100)
        forward_output.past_key_values = DynamicCache()
        self.mock_model.return_value = forward_output
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            temperature=0.7,
            max_tokens=20,
            top_p=0.85,
            top_k=30,
            do_sample=True,
            add_generation_prompt=True,
        )
        llm = self._create_llm(config)
        kv_cache = DynamicCache()
        resp = llm.generate([{"role": "user", "content": "Sampling"}], past_key_values=kv_cache)
        self.assertEqual(resp, self.standard_response)
