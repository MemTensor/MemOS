import asyncio
import os

from openai import AzureOpenAI as AzureClient
from openai import OpenAI as OpenAIClient

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.base import BaseEmbedder, log_embedding_call
from memos.log import get_logger


logger = get_logger(__name__)


def _sanitize_unicode(text: str) -> str:
    """
    Remove Unicode surrogates and other problematic characters.
    Surrogates (U+D800-U+DFFF) cause UnicodeEncodeError with some APIs.
    """
    try:
        # Encode with 'surrogatepass' then decode, replacing invalid chars
        cleaned = text.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="replace")
        # Replace replacement char with empty string for cleaner output
        return cleaned.replace("\ufffd", "")
    except Exception:
        # Fallback: remove all non-BMP characters
        return "".join(c for c in text if ord(c) < 0x10000)


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

    @log_embedding_call
    def embed(self, texts: list[str]) -> list[list[float]]:
        if isinstance(texts, str):
            texts = [texts]
        # Sanitize Unicode to prevent encoding errors with emoji/surrogates
        texts = [_sanitize_unicode(t) for t in texts]
        # Truncate texts if max_tokens is configured
        texts = self._truncate_texts(texts)
        if self.provider == "openai" or self.provider == "azure":
            try:

                async def _create_embeddings():
                    return self.client.embeddings.create(
                        model=getattr(self.config, "model_name_or_path", "text-embedding-3-large"),
                        input=texts,
                    )

                response = asyncio.run(
                    asyncio.wait_for(
                        _create_embeddings(), timeout=int(os.getenv("MOS_EMBEDDER_TIMEOUT", 5))
                    )
                )
                return [r.embedding for r in response.data]
            except Exception as e:
                if self.use_backup_client:
                    logger.warning(
                        "Embedding request failed error_type=%s; trying backup client",
                        type(e).__name__,
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

                        response = asyncio.run(
                            asyncio.wait_for(
                                _create_embeddings_backup(),
                                timeout=int(os.getenv("MOS_EMBEDDER_TIMEOUT", 5)),
                            )
                        )
                        return [r.embedding for r in response.data]
                    except Exception as e:
                        raise ValueError(f"Backup embeddings request ended with error: {e}") from e
                else:
                    raise ValueError(f"Embeddings request ended with error: {e}") from e
        else:
            raise ValueError(f"Embeddings unsupported provider: {self.provider}")
