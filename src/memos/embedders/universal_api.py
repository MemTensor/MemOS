from openai import OpenAI as OpenAIClient

from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.embedders.base import BaseEmbedder


class UniversalAPIEmbedder(BaseEmbedder):
    def __init__(self, config: UniversalAPIEmbedderConfig):
        self.provider = config.provider
        self.config = config

        if self.provider == "openai":
            self.client = OpenAIClient(api_key=config.api_key, base_url=config.base_url)
        else:
            raise ValueError(f"Unsupported provider: {self.provider}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        if self.provider == "openai":
            response = self.client.embeddings.create(
                model=self.config.get("model_name_or_path", "text-embedding-3-large"),
                input=texts,
            )
            return [r.embedding for r in response.data]
        else:
            raise ValueError(f"Unsupported provider: {self.provider}")
