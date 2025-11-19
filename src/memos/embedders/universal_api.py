from openai import AzureOpenAI as AzureClient
from openai import OpenAI as OpenAIClient

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.base import BaseEmbedder
from memos.log import get_logger
from memos.utils import timed


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

    @timed(log=True, log_prefix="EmbedderAPI")
    def embed(self, texts: list[str]) -> list[list[float]]:
        if self.provider == "openai" or self.provider == "azure":
            try:
                response = self.client.embeddings.create(
                    model=getattr(self.config, "model_name_or_path", "text-embedding-3-large"),
                    input=texts,
                )
                return [r.embedding for r in response.data]
            except Exception as e:
                raise Exception(f"Embeddings request ended with error: {e}") from e
        else:
            raise ValueError(f"Embeddings unsupported provider: {self.provider}")
