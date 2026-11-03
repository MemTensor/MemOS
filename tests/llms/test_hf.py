import unittest

from unittest.mock import MagicMock, patch

import pytest

from transformers import DynamicCache

from memos.configs.llm import HFLLMConfig, LLMConfigFactory
from memos.llms.factory import LLMFactory
from memos.llms.hf import HFLLM
from memos.memories.activation.kv import clone_dynamic_cache
from tests.utils import (
    dynamic_cache_key_tensors,
    dynamic_cache_seq_len,
    make_dynamic_cache,
)


# The KV cache is a torch structure; skip the whole module where torch is
# not installed instead of failing the collection of the test suite.
torch = pytest.importorskip("torch")


def make_activation_memory(cache):
    """Build a ``KVCacheMemory`` that stores a single KV cache.

    Args:
        cache: The cache to store in the memory.

    Returns:
        tuple: The memory and the stored ``KVCacheItem``.
    """
    from memos.configs.memory import KVCacheMemoryConfig
    from memos.memories.activation.item import KVCacheItem
    from memos.memories.activation.kv import KVCacheMemory

    config = MagicMock(spec=KVCacheMemoryConfig)
    config.extractor_llm = MagicMock()
    config.memory_filename = "test_kv_cache.pkl"
    with patch("memos.llms.factory.LLMFactory.from_config", return_value=MagicMock()):
        memory = KVCacheMemory(config)

    item = KVCacheItem(memory=cache)
    memory.add([item])
    return memory, item


class CacheGrowingModel:
    """A stand-in for a transformers model that grows the cache in place.

    Real transformers models append the newly generated key/value tensors to
    the ``past_key_values`` object they are given (``DynamicLayer.update``
    rebinds ``keys``/``values`` on the very same layer object). Handing the
    stored activation cache to the model therefore grows the stored cache with
    every turn.
    """

    def __init__(self, device: str = "cpu") -> None:
        self.device = device
        self.received_caches = []

    def __call__(
        self, input_ids=None, use_cache=False, past_key_values=None, return_dict=True, **kwargs
    ):
        self.received_caches.append(past_key_values)
        if past_key_values is not None:
            past_key_values.update(torch.zeros(1, 2, 1, 4), torch.ones(1, 2, 1, 4), 0)
        output = MagicMock()
        output.logits = torch.full((1, 1, 100), -1e9)
        output.logits[0, 0, 7] = 1.0
        output.past_key_values = past_key_values
        return output


@patch("transformers.AutoModelForCausalLM", MagicMock())
@patch("transformers.AutoTokenizer", MagicMock())
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

    def test_generate_does_not_mutate_caller_cache(self):
        # Regression for #2301: the cache stored in the activation memory must
        # not grow with the tokens generated for the current turn.
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            max_tokens=5,
            do_sample=False,
            add_generation_prompt=True,
        )
        llm = self._create_llm(config)
        model = CacheGrowingModel()
        llm.model = model

        cache = make_dynamic_cache(seq_len=3)
        resp = llm.generate([{"role": "user", "content": "Hello"}], past_key_values=cache)

        self.assertEqual(resp, self.standard_response)
        # The model received a copy, not the caller's cache.
        self.assertIsNot(model.received_caches[0], cache)
        # The copy did grow, i.e. the model really appends in place.
        self.assertGreater(dynamic_cache_seq_len(model.received_caches[0]), 3)
        # The caller's cache still holds only the original tokens.
        self.assertEqual(dynamic_cache_seq_len(cache), 3)

    def test_generate_stream_does_not_mutate_caller_cache(self):
        # Same regression for the streaming path.
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            max_tokens=5,
            do_sample=False,
            add_generation_prompt=True,
        )
        llm = self._create_llm(config)
        model = CacheGrowingModel()
        llm.model = model

        cache = make_dynamic_cache(seq_len=3)
        chunks = list(
            llm.generate_stream([{"role": "user", "content": "Hello"}], past_key_values=cache)
        )

        self.assertTrue(chunks)
        # The model received a copy, not the caller's cache.
        self.assertIsNot(model.received_caches[0], cache)
        # The copy did grow, i.e. the model really appends in place.
        self.assertGreater(dynamic_cache_seq_len(model.received_caches[0]), 3)
        # The caller's cache still holds only the original tokens.
        self.assertEqual(dynamic_cache_seq_len(cache), 3)

    def test_generation_from_get_cache_copies_the_kv_tensors_only_once(self):
        # The public API path: the activation memory hands out a cache with
        # get_cache(), the caller passes it to generate(). The stored cache
        # must stay read-only, and the K/V tensors must not be copied twice
        # along the way -- one copy would already keep three full sets of
        # tensors alive (stored + copy 1 + copy 2).
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            max_tokens=5,
            do_sample=False,
            add_generation_prompt=True,
        )
        llm = self._create_llm(config)
        model = CacheGrowingModel()
        llm.model = model

        stored_cache = make_dynamic_cache(seq_len=3)
        memory, item = make_activation_memory(stored_cache)

        with patch(
            "memos.memories.activation.kv.clone_dynamic_cache", wraps=clone_dynamic_cache
        ) as clone_spy:
            cached = memory.get_cache([item.id])
            resp = llm.generate([{"role": "user", "content": "Hello"}], past_key_values=cached)

        self.assertEqual(resp, self.standard_response)
        # The whole path copies the K/V tensors exactly once.
        self.assertEqual(clone_spy.call_count, 1)
        # The model received the cache the memory handed out, not a second copy.
        self.assertIs(model.received_caches[0], cached)
        # The copy the model wrote into does not alias the stored tensors.
        self.assertNotEqual(
            dynamic_cache_key_tensors(model.received_caches[0])[0].data_ptr(),
            dynamic_cache_key_tensors(item.memory)[0].data_ptr(),
        )
        # The copy did grow, i.e. the model really appends in place.
        self.assertGreater(dynamic_cache_seq_len(model.received_caches[0]), 3)
        # The stored cache was not rewritten: it still holds only the
        # original tokens.
        self.assertEqual(dynamic_cache_seq_len(item.memory), 3)
        self.assertEqual(dynamic_cache_seq_len(stored_cache), 3)

    def test_generation_from_get_cache_keeps_the_stored_cache_read_only(self):
        # The stored cache stays read-only even when it is handed out a second
        # time and when a caller stores an already owned copy back.
        config = HFLLMConfig(
            model_name_or_path="qwen3:0.6b",
            max_tokens=5,
            do_sample=False,
            add_generation_prompt=True,
        )
        llm = self._create_llm(config)
        model = CacheGrowingModel()
        llm.model = model

        stored_cache = make_dynamic_cache(seq_len=3)
        memory, item = make_activation_memory(stored_cache)

        cached = memory.get_cache([item.id])
        llm.generate([{"role": "user", "content": "Hello"}], past_key_values=cached)

        # The stored cache kept its original length.
        self.assertEqual(dynamic_cache_seq_len(item.memory), 3)
        self.assertEqual(dynamic_cache_seq_len(stored_cache), 3)

        # A cache that is stored back into the memory is owned by the memory
        # again: the model must copy it before it appends to it.
        memory.add([item])
        llm.generate([{"role": "user", "content": "Hello"}], past_key_values=item.memory)

        self.assertIsNot(model.received_caches[-1], item.memory)
        self.assertEqual(dynamic_cache_seq_len(item.memory), 3)
