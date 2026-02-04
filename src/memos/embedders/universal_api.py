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
        self.use_backup_client = config.backup_client
        if self.use_backup_client:
            self.backup_client = OpenAIClient(
                api_key=config.backup_api_key,
                base_url=config.backup_base_url,
                default_headers=config.backup_headers_extra
                if config.backup_headers_extra
                else None,
            )

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

                async def _create_embeddings():
                    return self.client.embeddings.create(
                        model=getattr(self.config, "model_name_or_path", "text-embedding-3-large"),
                        input=texts,
                    )

                init_time = time.time()
                response = asyncio.run(
                    asyncio.wait_for(
                        _create_embeddings(), timeout=int(os.getenv("MOS_EMBEDDER_TIMEOUT", 5))
                    )
                )
                logger.info(f"Embeddings request succeeded with {time.time() - init_time} seconds")
                logger.info(f"Embeddings request response: {response}")
                return [r.embedding for r in response.data]
            except Exception as e:
                if self.use_backup_client:
                    logger.warning(
                        f"Embeddings request ended with {type(e).__name__} error: {e}, try backup client"
                    )
                    try:

                        async def _create_embeddings_backup():
                            return self.backup_client.embeddings.create(
                                model=getattr(
                                    self.config,
                                    "backup_model_name_or_path",
                                    "text-embedding-3-large",
                                ),
                                input=texts,
                            )

                        init_time = time.time()
                        response = asyncio.run(
                            asyncio.wait_for(
                                _create_embeddings_backup(),
                                timeout=int(os.getenv("MOS_EMBEDDER_TIMEOUT", 5)),
                            )
                        )
                        logger.info(
                            f"Backup embeddings request succeeded with {time.time() - init_time} seconds"
                        )
                        logger.info(f"Backup embeddings request response: {response}")
                        return [r.embedding for r in response.data]
                    except Exception as e:
                        raise ValueError(f"Backup embeddings request ended with error: {e}") from e
                else:
                    raise ValueError(f"Embeddings request ended with error: {e}") from e
        else:
            raise ValueError(f"Embeddings unsupported provider: {self.provider}")
