import asyncio
from typing import Optional, Any, cast

import torch
from transformers.cache_utils import DynamicCache

from memos.configs.llm import VLLMLLMConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList


logger = get_logger(__name__)


class VLLMLLM(BaseLLM):
    """
    VLLM LLM class for connecting to existing vLLM servers.
    """

    def __init__(self, config: VLLMLLMConfig):
        """
        Initialize the VLLM LLM to connect to an existing vLLM server.
        """
        self.config = config
        
        # Initialize OpenAI client for API calls
        self.client = None
        api_key = getattr(self.config, "api_key", "dummy")
        if not api_key:
            api_key = "dummy"

        import openai
        self.client = openai.Client(
            api_key=api_key, 
            base_url=getattr(self.config, "api_base", "http://localhost:8088/v1")
        )
    
    def build_vllm_kv_cache(self, messages: Any) -> str:
        """
        Build a KV cache from chat messages via one vLLM request.
        Handles str, list[str], and MessageList formats.
        """
        # 1. Normalize input to a MessageList
        processed_messages: MessageList = []
        if isinstance(messages, str):
            processed_messages = [{"role": "system", "content": f"Below is some information about the user.\n{messages}"}]
        elif isinstance(messages, list):
            if not messages:
                pass # Empty list
            elif isinstance(messages[0], str):
                str_content = " ".join(str(msg) for msg in messages)
                processed_messages = [{"role": "system", "content": f"Below is some information about the user.\n{str_content}"}]
            elif isinstance(messages[0], dict):
                 processed_messages = cast(MessageList, messages)

        # 2. Convert to prompt for logging/return value.
        prompt = self._messages_to_prompt(processed_messages)
        
        if not prompt.strip():
            raise ValueError("Prompt is empty, cannot build KV cache.")
        
        # 3. Send request to vLLM server to preload the KV cache
        if self.client:
            try:
                # Use the processed messages for the API call
                prefill_kwargs = {
                    "model": self.config.model_name_or_path,
                    "messages": processed_messages,
                    "max_tokens": 2,
                    "temperature": 0.0,
                    "top_p": 1.0,
                }
                self.client.chat.completions.create(**prefill_kwargs)
                logger.info(f"vLLM KV cache prefill completed for prompt: '{prompt[:100]}...'")
            except Exception as e:
                logger.warning(f"Failed to prefill vLLM KV cache: {e}")
        
        return prompt 
    
    def generate(self, messages: MessageList) -> str:
        """
        Generate a response from the model.
        """
        if self.client:
            return self._generate_with_api_client(messages)
        else:
            raise RuntimeError("API client is not available")
    
    def _generate_with_api_client(self, messages: MessageList) -> str:
        """
        Generate response using vLLM API client.
        """
        if self.client:
            completion_kwargs = {
                "model": self.config.model_name_or_path,
                "messages": messages,
                "temperature": float(getattr(self.config, "temperature", 0.8)),
                "max_tokens": int(getattr(self.config, "max_tokens", 1024)),
                "top_p": float(getattr(self.config, "top_p", 0.9)),
            }
            
            response = self.client.chat.completions.create(**completion_kwargs)
            response_text = response.choices[0].message.content or ""
            logger.info(f"VLLM API response: {response_text}")
            return remove_thinking_tags(response_text) if getattr(self.config, "remove_think_prefix", False) else response_text
        else:
            raise RuntimeError("API client is not available")
    
    def _messages_to_prompt(self, messages: MessageList) -> str:
        """
        Convert messages to prompt string.
        """
        prompt_parts = []
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            prompt_parts.append(f"{role.capitalize()}: {content}")
        return "\n".join(prompt_parts)
    
    
