import asyncio
from typing import Optional, Dict, Any

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
        if hasattr(self.config, "api_key") and self.config.api_key:
            import openai
            self.client = openai.Client(
                api_key=self.config.api_key, 
                base_url=getattr(self.config, "api_base", "http://localhost:8088")
            )
        else:
            # Create client without API key for local servers
            import openai
            self.client = openai.Client(
                api_key="dummy",  # vLLM local server doesn't require real API key
                base_url=getattr(self.config, "api_base", "http://localhost:8088")
            )
    
    def build_vllm_kv_cache(self, messages) -> str:
        """
        Build a KV cache from chat messages via one vLLM request.
        Supports the following input types:
            - str: Used as a system prompt.
            - list[str]: Concatenated and used as a system prompt.
            - list[dict]: Used directly as chat messages.
        The messages are always converted to a standard chat template.
        Raises:
            ValueError: If the resulting prompt is empty after template processing.
        Returns:
            str: The constructed prompt string for vLLM KV cache building.
        """
        # Accept multiple input types and convert to standard chat messages
        if isinstance(messages, str):
            messages = [
                {
                    "role": "system",
                    "content": f"Below is some information about the user.\n{messages}",
                }
            ]
        elif isinstance(messages, list) and messages and isinstance(messages[0], str):
            # Handle list of strings
            str_messages = [str(msg) for msg in messages]
            messages = [
                {
                    "role": "system",
                    "content": f"Below is some information about the user.\n{' '.join(str_messages)}",
                }
            ]
        
        # Convert messages to prompt string using the same logic as HFLLM
        # Convert to MessageList format for _messages_to_prompt
        if isinstance(messages, str):
            message_list = [{"role": "system", "content": messages}]
        elif isinstance(messages, list) and messages and isinstance(messages[0], str):
            str_messages = [str(msg) for msg in messages]
            message_list = [{"role": "system", "content": " ".join(str_messages)}]
        else:
            message_list = messages  # Assume it's already in MessageList format
        
        # Convert to proper MessageList type
        from memos.types import MessageList
        typed_message_list: MessageList = []
        for msg in message_list:
            if isinstance(msg, dict) and "role" in msg and "content" in msg:
                typed_message_list.append({
                    "role": str(msg["role"]),
                    "content": str(msg["content"])
                })
        
        prompt = self._messages_to_prompt(typed_message_list)
        
        if not prompt.strip():
            raise ValueError(
                "Prompt after chat template is empty, cannot build KV cache. Check your messages input."
            )
        
        # Send a request to vLLM server to preload the KV cache
        # This is done by sending a completion request with max_tokens=0
        # which will cause vLLM to process the input but not generate any output
        if self.client is not None:
            # Convert messages to OpenAI format
            openai_messages = []
            for msg in messages:
                openai_messages.append({
                    "role": msg["role"],
                    "content": msg["content"]
                })
            
            # Send prefill request to vLLM
            try:
                prefill_kwargs = {
                    "model": "default",  # vLLM uses "default" as model name
                    "messages": openai_messages,
                    "max_tokens": 2,  # Don't generate any tokens, just prefill
                    "temperature": 0.0,  # Use deterministic sampling for prefill
                    "top_p": 1.0,
                    "top_k": 1,
                }
                prefill_response = self.client.chat.completions.create(**prefill_kwargs)
                logger.info(f"vLLM KV cache prefill completed for prompt length: {len(prompt)}")
            except Exception as e:
                logger.warning(f"Failed to prefill vLLM KV cache: {e}")
                # Continue anyway, as this is not critical for functionality
        
        return prompt 
    
    def generate(self, messages: MessageList, past_key_values: Optional[DynamicCache] = None) -> str:
        """
        Generate a response from the model.
        Args:
            messages (MessageList): Chat messages for prompt construction.
        Returns:
            str: Model response.
        """
        if self.client is not None:
            return self._generate_with_api_client(messages)
        else:
            raise RuntimeError("API client is not available")
    
    def _generate_with_api_client(self, messages: MessageList) -> str:
        """
        Generate response using vLLM API client.
        """
        # Convert messages to OpenAI format
        openai_messages = []
        for msg in messages:
            openai_messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })
        
        # Generate response
        if self.client is not None:
            # Create completion request with proper parameter types
            completion_kwargs = {
                "model": "default",  # vLLM uses "default" as model name
                "messages": openai_messages,
                "temperature": float(getattr(self.config, "temperature", 0.8)),
                "max_tokens": int(getattr(self.config, "max_tokens", 1024)),
                "top_p": float(getattr(self.config, "top_p", 0.9)),
            }
            
            # Add top_k only if it's greater than 0
            top_k = getattr(self.config, "top_k", 50)
            if top_k > 0:
                completion_kwargs["top_k"] = int(top_k)
            
            response = self.client.chat.completions.create(**completion_kwargs)
        else:
            raise RuntimeError("API client is not available")
        
        response_text = response.choices[0].message.content or ""
        logger.info(f"VLLM API response: {response_text}")
        
        return (
            remove_thinking_tags(response_text)
            if getattr(self.config, "remove_think_prefix", False)
            else response_text
        )
    
    def _messages_to_prompt(self, messages: MessageList) -> str:
        """
        Convert messages to prompt string.
        """
        # Simple conversion - can be enhanced with proper chat template
        prompt_parts = []
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            
            if role == "system":
                prompt_parts.append(f"System: {content}")
            elif role == "user":
                prompt_parts.append(f"User: {content}")
            elif role == "assistant":
                prompt_parts.append(f"Assistant: {content}")
        
        return "\n".join(prompt_parts)
    
    
