from collections.abc import Generator
from typing import Any

from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DynamicCache,
    LogitsProcessorList,
    TemperatureLogitsWarper,
    TopKLogitsWarper,
    TopPLogitsWarper,
)

from memos.configs.llm import HFLLMConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList


logger = get_logger(__name__)


class HFLLM(BaseLLM):
    """
    HFLLM: Transformers LLM class supporting cache-augmented generation (CAG) and sampling.
    """

    def __init__(self, config: HFLLMConfig):
        """
        Initialize the HFLLM model and tokenizer, and set up logits processors for sampling.
        """
        self.config = config

        # Default model if not specified
        if not self.config.model_name_or_path:
            self.config.model_name_or_path = "Qwen/Qwen3-1.7B"

        # Initialize hf model
        self.model = AutoModelForCausalLM.from_pretrained(
            self.config.model_name_or_path, torch_dtype="auto", device_map="auto"
        )
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.config.model_name_or_path, use_fast=True
        )

        # Logits processors for sampling
        processors = []
        if getattr(self.config, "temperature", 1.0) != 1.0:
            processors.append(TemperatureLogitsWarper(self.config.temperature))
        if getattr(self.config, "top_k", 0) > 0:
            processors.append(TopKLogitsWarper(self.config.top_k))
        if 0.0 < getattr(self.config, "top_p", 1.0) < 1.0:
            processors.append(TopPLogitsWarper(self.config.top_p))
        self.logits_processors = LogitsProcessorList(processors)

    def generate(
        self, messages: MessageList, past_key_values: DynamicCache | None = None, **kwargs
    ):
        """
        Generate a response from the model. If past_key_values is provided, use cache-augmented generation.
        Args:
            messages (MessageList): Chat messages for prompt construction.
            past_key_values (DynamicCache | None): Optional KV cache for fast generation.
        Returns:
            str: Model response.
        """
        prompt = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=self.config.add_generation_prompt
        )
        logger.info(f"HFLLM prompt: {prompt}")
        if past_key_values is None:
            return self._generate_full(prompt, **kwargs)
        else:
            return self._generate_with_cache(prompt, past_key_values, **kwargs)

    def generate_stream(
        self, messages: MessageList, past_key_values: DynamicCache | None = None, **kwargs
    ) -> Generator[str, None, None]:
        """
        Generate a streaming response from the model.
        Args:
            messages (MessageList): Chat messages for prompt construction.
            past_key_values (DynamicCache | None): Optional KV cache for fast generation.
        Yields:
            str: Streaming model response chunks.
        """
        prompt = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=self.config.add_generation_prompt
        )
        logger.info(f"HFLLM streaming prompt: {prompt}")
        if past_key_values is None:
            yield from self._generate_full_stream(prompt)
        else:
            yield from self._generate_with_cache_stream(prompt, past_key_values)

    def _generate_full(self, prompt: str, **kwargs) -> str:
        """
        Generate output from scratch using the full prompt.
        Args:
            prompt (str): The input prompt string.
        Returns:
            str: Model response.
        """
        inputs = self.tokenizer([prompt], return_tensors="pt").to(self.model.device)
        gen_kwargs = {
            "max_new_tokens": kwargs.get("max_tokens", self.config.max_tokens),
            "do_sample": getattr(self.config, "do_sample", True),
        }
        if self.config.do_sample:
            gen_kwargs["temperature"] = kwargs.get("temperature", self.config.temperature)
            gen_kwargs["top_k"] = kwargs.get("top_k", self.config.top_k)
            gen_kwargs["top_p"] = kwargs.get("top_p", self.config.top_p)
        gen_ids = self.model.generate(
            **inputs,
            **gen_kwargs,
        )
        new_ids = [
            out_ids[len(src_ids) :]
            for src_ids, out_ids in zip(inputs.input_ids, gen_ids, strict=False)
        ]
        response = self.tokenizer.batch_decode(new_ids, skip_special_tokens=True)[0]
        logger.info(f"Full-gen raw response: {response}")
        return (
            remove_thinking_tags(response)
            if getattr(self.config, "remove_think_prefix", False)
            else response
        )

    def _generate_full_stream(self, prompt: str, **kwargs) -> Generator[str, None, None]:
        """
        Generate output from scratch using the full prompt with streaming.
        Args:
            prompt (str): The input prompt string.
        Yields:
            str: Streaming response chunks.
        """
        import torch

        inputs = self.tokenizer([prompt], return_tensors="pt").to(self.model.device)

        # Get generation parameters
        max_new_tokens = kwargs.get("max_tokens", self.config.max_tokens)
        remove_think_prefix = getattr(self.config, "remove_think_prefix", False)

        # Manual streaming generation
        generated_ids = inputs.input_ids.clone()
        accumulated_text = ""

        for _ in range(max_new_tokens):
            # Forward pass
            with torch.no_grad():
                outputs = self.model(
                    input_ids=generated_ids,
                    use_cache=True,
                    return_dict=True,
                )

            # Get next token logits
            next_token_logits = outputs.logits[:, -1, :]

            # Apply logits processors if sampling
            if getattr(self.config, "do_sample", True):
                batch_size, _ = next_token_logits.size()
                dummy_ids = torch.zeros(
                    (batch_size, 1), dtype=torch.long, device=next_token_logits.device
                )
                filtered_logits = self.logits_processors(dummy_ids, next_token_logits)
                probs = torch.softmax(filtered_logits, dim=-1)
                next_token = torch.multinomial(probs, num_samples=1)
            else:
                next_token = torch.argmax(next_token_logits, dim=-1, keepdim=True)

            # Check for EOS token
            if self._should_stop(next_token):
                break

            # Append new token
            generated_ids = torch.cat([generated_ids, next_token], dim=-1)

            # Decode and yield the new token
            new_token_text = self.tokenizer.decode(next_token[0], skip_special_tokens=True)
            if new_token_text:  # Only yield non-empty tokens
                accumulated_text += new_token_text

                # Apply thinking tag removal if enabled
                if remove_think_prefix:
                    processed_text = remove_thinking_tags(accumulated_text)
                    # Only yield the difference (new content)
                    if len(processed_text) > len(accumulated_text) - len(new_token_text):
                        yield processed_text[len(accumulated_text) - len(new_token_text) :]
                    else:
                        yield new_token_text
                else:
                    yield new_token_text

    def _generate_with_cache(self, query: str, kv: DynamicCache, **kwargs) -> str:
        """
        Generate output incrementally using an existing KV cache.
        Args:
            query (str): The new user query string.
            kv (DynamicCache): The prefilled KV cache.
        Returns:
            str: Model response.
        """
        import torch

        query_ids = self.tokenizer(
            query, return_tensors="pt", add_special_tokens=False
        ).input_ids.to(self.model.device)
        logits, kv = self._prefill(query_ids, kv)
        next_token = self._select_next_token(logits)
        generated = [next_token]
        for _ in range(kwargs.get("max_tokens", self.config.max_tokens) - 1):
            if self._should_stop(next_token):
                break
            logits, kv = self._prefill(next_token, kv)
            next_token = self._select_next_token(logits)
            generated.append(next_token)
        if generated:
            concat = torch.cat(generated, dim=-1)
            response = self.tokenizer.decode(concat[0], skip_special_tokens=True)
        else:
            response = ""
        logger.info(f"Cache-gen raw response: {response}")
        return (
            remove_thinking_tags(response)
            if getattr(self.config, "remove_think_prefix", False)
            else response
        )

    def _generate_with_cache_stream(
        self, query: str, kv: DynamicCache, **kwargs
    ) -> Generator[str, None, None]:
        """
        Generate output incrementally using an existing KV cache with streaming.
        Args:
            query (str): The new user query string.
            kv (DynamicCache): The prefilled KV cache.
        Yields:
            str: Streaming response chunks.
        """
        query_ids = self.tokenizer(
            query, return_tensors="pt", add_special_tokens=False
        ).input_ids.to(self.model.device)

        max_new_tokens = kwargs.get("max_tokens", self.config.max_tokens)
        remove_think_prefix = getattr(self.config, "remove_think_prefix", False)

        # Initial forward pass
        logits, kv = self._prefill(query_ids, kv)
        next_token = self._select_next_token(logits)

        # Yield first token
        first_token_text = self.tokenizer.decode(next_token[0], skip_special_tokens=True)
        accumulated_text = ""
        if first_token_text:
            accumulated_text += first_token_text
            if remove_think_prefix:
                processed_text = remove_thinking_tags(accumulated_text)
                if len(processed_text) > len(accumulated_text) - len(first_token_text):
                    yield processed_text[len(accumulated_text) - len(first_token_text) :]
                else:
                    yield first_token_text
            else:
                yield first_token_text

        generated = [next_token]

        # Continue generation
        for _ in range(max_new_tokens - 1):
            if self._should_stop(next_token):
                break
            logits, kv = self._prefill(next_token, kv)
            next_token = self._select_next_token(logits)

            # Decode and yield the new token
            new_token_text = self.tokenizer.decode(next_token[0], skip_special_tokens=True)
            if new_token_text:
                accumulated_text += new_token_text

                # Apply thinking tag removal if enabled
                if remove_think_prefix:
                    processed_text = remove_thinking_tags(accumulated_text)
                    # Only yield the difference (new content)
                    if len(processed_text) > len(accumulated_text) - len(new_token_text):
                        yield processed_text[len(accumulated_text) - len(new_token_text) :]
                    else:
                        yield new_token_text
                else:
                    yield new_token_text

            generated.append(next_token)

    def _prefill(self, input_ids: Any, kv: DynamicCache) -> tuple[Any, DynamicCache]:
        """
        Forward the model once, returning last-step logits and updated KV cache.
        Args:
            input_ids (torch.Tensor): Input token IDs.
            kv (DynamicCache): Existing KV cache.
        Returns:
            tuple[torch.Tensor, DynamicCache]: (last-step logits, updated KV cache)
        """
        import torch

        with torch.no_grad():
            out = self.model(
                input_ids=input_ids,
                use_cache=True,
                past_key_values=kv,
                return_dict=True,
            )
        return out.logits[:, -1, :], out.past_key_values

    def _select_next_token(self, logits: Any) -> Any:
        """
        Select the next token from logits using sampling or argmax, depending on config.
        Args:
            logits (torch.Tensor): Logits for the next token.
        Returns:
            torch.Tensor: Selected token ID(s).
        """
        import torch

        if getattr(self.config, "do_sample", True):
            batch_size, _ = logits.size()
            dummy_ids = torch.zeros((batch_size, 1), dtype=torch.long, device=logits.device)
            filtered = self.logits_processors(dummy_ids, logits)
            probs = torch.softmax(filtered, dim=-1)
            return torch.multinomial(probs, num_samples=1)
        return torch.argmax(logits, dim=-1, keepdim=True)

    def _should_stop(self, token: Any) -> bool:
        """
        Check if the given token is the EOS (end-of-sequence) token.
        Args:
            token (torch.Tensor): Token ID to check.
        Returns:
            bool: True if token is EOS, else False.
        """
        eos_id = self.tokenizer.eos_token_id
        return eos_id is not None and token.item() == eos_id

    def build_kv_cache(self, messages) -> DynamicCache:
        """
        Build a KV cache from chat messages via one forward pass.
        Supports the following input types:
            - str: Used as a system prompt.
            - list[str]: Concatenated and used as a system prompt.
            - list[dict]: Used directly as chat messages.
        The messages are always converted to a standard chat template.
        Raises:
            ValueError: If the resulting prompt is empty after template processing.
        Returns:
            DynamicCache: The constructed KV cache object.
        """
        import torch

        # Accept multiple input types and convert to standard chat messages
        if isinstance(messages, str):
            messages = [
                {
                    "role": "system",
                    "content": f"Below is some information about the user.\n{messages}",
                }
            ]
        elif isinstance(messages, list) and messages and isinstance(messages[0], str):
            messages = [
                {
                    "role": "system",
                    "content": f"Below is some information about the user.\n{' '.join(messages)}",
                }
            ]
        prompt = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )
        inputs = self.tokenizer(prompt, return_tensors="pt")
        inputs["input_ids"] = inputs["input_ids"].to(self.model.device, dtype=torch.long)
        seq_len = inputs["input_ids"].size(-1)
        if seq_len == 0:
            raise ValueError(
                "Prompt after chat template is empty, cannot build KV cache. Check your messages input."
            )
        # Create cache and perform forward pass without pre-existing cache
        with torch.no_grad():
            outputs = self.model(**inputs, use_cache=True)

        # Get the cache from model outputs
        if hasattr(outputs, "past_key_values") and outputs.past_key_values is not None:
            kv = outputs.past_key_values

            # Convert from legacy tuple format to DynamicCache if needed
            if isinstance(kv, tuple):
                kv = DynamicCache.from_legacy_cache(kv)

            # Handle compatibility between old and new transformers versions
            # In newer versions, DynamicCache uses 'layers' attribute
            # In older versions, it uses 'key_cache' and 'value_cache' attributes
            if hasattr(kv, "layers"):
                # New version: trim cache using layers attribute
                for layer in kv.layers:
                    if hasattr(layer, "key_cache") and hasattr(layer, "value_cache"):
                        # Trim each layer's cache to the sequence length
                        if layer.key_cache is not None:
                            layer.key_cache = layer.key_cache[:, :, :seq_len, :]
                        if layer.value_cache is not None:
                            layer.value_cache = layer.value_cache[:, :, :seq_len, :]
                    elif hasattr(layer, "keys") and hasattr(layer, "values"):
                        # Alternative attribute names in some versions
                        if layer.keys is not None:
                            layer.keys = layer.keys[:, :, :seq_len, :]
                        if layer.values is not None:
                            layer.values = layer.values[:, :, :seq_len, :]
            elif hasattr(kv, "key_cache") and hasattr(kv, "value_cache"):
                # Old version: trim cache using key_cache and value_cache attributes
                for i in range(len(kv.key_cache)):
                    if kv.key_cache[i] is not None:
                        kv.key_cache[i] = kv.key_cache[i][:, :, :seq_len, :]
                    if kv.value_cache[i] is not None:
                        kv.value_cache[i] = kv.value_cache[i][:, :, :seq_len, :]
            else:
                # Fallback: log warning but continue without trimming
                logger.warning(
                    f"DynamicCache object of type {type(kv)} has unexpected structure. "
                    f"Cache trimming skipped. Available attributes: {dir(kv)}"
                )

            return kv
        else:
            raise RuntimeError(
                "Failed to build KV cache: no cache data available from model outputs"
            )
