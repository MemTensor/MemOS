import asyncio
import os
import time

from openai import AzureOpenAI as AzureClient
from openai import OpenAI as OpenAIClient

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.base import BaseEmbedder
from memos.log import get_logger
from memos.utils import timed_with_status


logger = get_logger(__name__)


class UniversalAPIEmbedder(BaseEmbedder):
    def __init__(self, config: UniversalAPIEmbedderConfig):
        self.provider = config.provider
        self.config = config

        if self.provider == "openai":
            self.client = OpenAIClient(
                api_key=config.api_key,
                base_url=config.base_url,
                default_headers=config.headers_extra if config.headers_extra else None,
            )
        elif self.provider == "azure":
            self.client = AzureClient(
                azure_endpoint=config.base_url,
                api_version="2024-03-01-preview",
                api_key=config.api_key,
            )
        else:
            raise ValueError(f"Embeddings unsupported provider: {self.provider}")

    @timed_with_status(
        log_prefix="model_timed_embedding",
        log_extra_args=lambda self, texts: {
            "model_name_or_path": "text-embedding-3-large",
            "text_len": len(texts),
            "text_content": texts,
        },
    )
    def embed(self, texts: list[str]) -> list[list[float]]:
        if isinstance(texts, str):
            texts = [texts]
        # Truncate texts if max_tokens is configured
        texts = self._truncate_texts(texts)
        logger.info(f"Embeddings request with input: {texts}")
        if self.provider == "openai" or self.provider == "azure":
            try:
                # use asyncio.wait_for to implement 3 seconds timeout, fallback to default client if timeout
                async def _create_embeddings():
                    return self.client.embeddings.create(
                        model=getattr(self.config, "model_name_or_path", "text-embedding-3-large"),
                        input=texts,
                    )

                try:
                    # wait for environment variable specified timeout (5 seconds), trigger asyncio.TimeoutError if timeout
                    init_time = time.time()
                    response = asyncio.run(
                        asyncio.wait_for(
                            _create_embeddings(), timeout=int(os.getenv("MOS_EMBEDDER_TIMEOUT", 5))
                        )
                    )
                    logger.info(
                        f"Embeddings request succeeded with {time.time() - init_time} seconds"
                    )
                    return [r.embedding for r in response.data]
                except asyncio.TimeoutError:
                    logger.warning(
                        f"Embeddings request timed out after {os.getenv('MOS_EMBEDDER_TIMEOUT', 5)} seconds, fallback to default client"
                    )
                    client = OpenAIClient(
                        api_key=os.getenv("OPENAI_API_KEY", "sk-xxxx"),
                        base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                        default_headers=self.config.headers_extra
                        if self.config.headers_extra
                        else None,
                    )
                    init_time = time.time()
                    response = client.embeddings.create(
                        model=getattr(self.config, "model_name_or_path", "text-embedding-3-large"),
                        input=texts,
                    )
                    logger.info(
                        f"Embeddings request using default client succeeded with {time.time() - init_time} seconds"
                    )
                    return [r.embedding for r in response.data]
            except Exception as e:
                raise Exception(f"Embeddings request ended with error: {e}") from e
        else:
            raise ValueError(f"Embeddings unsupported provider: {self.provider}")
