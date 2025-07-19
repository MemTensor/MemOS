from openai import AzureOpenAI as AzureClient
from openai import OpenAI as OpenAIClient

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.base import BaseEmbedder


class UniversalAPIEmbedder(BaseEmbedder):
    def __init__(self, config: UniversalAPIEmbedderConfig):
        self.provider = config.provider
        self.config = config

        if self.provider == "openai":
            self.client = OpenAIClient(api_key=config.api_key, base_url=config.base_url)
        elif self.provider == "azure":
            self.client = AzureClient(
                azure_endpoint=config.base_url,
                api_version="2024-03-01-preview",
                api_key=config.api_key,
            )
        else:
            raise ValueError(f"Unsupported provider: {self.provider}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        if self.provider == "openai" or self.provider == "azure":
            response = self.client.embeddings.create(
                model=getattr(self.config, "model_name_or_path", "text-embedding-3-large"),
                input=texts,
            )
            return [r.embedding for r in response.data]
        else:
            raise ValueError(f"Unsupported provider: {self.provider}")
