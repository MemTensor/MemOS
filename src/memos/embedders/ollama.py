from ollama import Client

from memos.configs.embedder import OllamaEmbedderConfig
from memos.embedders.base import BaseEmbedder
from memos.log import get_logger


logger = get_logger(__name__)


class OllamaEmbedder(BaseEmbedder):
    """Ollama Embedder class."""

    def __init__(self, config: OllamaEmbedderConfig):
        self.config = config
        self.api_base = config.api_base

        if self.config.embedding_dims is not None:
            logger.warning(
                "Ollama does not support specifying embedding dimensions. "
                "The embedding dimensions is determined by the model."
                "`embedding_dims` will be set to None."
            )
            self.config.embedding_dims = None

        # Default model if not specified
        if not self.config.model_name_or_path:
            self.config.model_name_or_path = "nomic-embed-text:latest"

        # Initialize ollama client
        self.client = Client(host=self.api_base)

        # Ensure the model exists locally
        self._ensure_model_exists()

    def _list_models(self) -> list[str]:
        """
        List all models available in the Ollama client.

        Returns:
            List of model names.
        """
        local_models = self.client.list()["models"]
        return [model.model for model in local_models]

    def _ensure_model_exists(self):
        """
        Ensure the specified model exists locally. If not, pull it from Ollama.
        """
        try:
            local_models = self._list_models()
            if self.config.model_name_or_path not in local_models:
                logger.warning(
                    f"Model {self.config.model_name_or_path} not found locally. Pulling from Ollama..."
                )
                self.client.pull(self.config.model_name_or_path)
        except Exception as e:
            logger.warning(f"Could not verify model existence: {e}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for the given texts.

        Args:
            texts: List of texts to embed.

        Returns:
            List of embeddings, each represented as a list of floats.
        """
        # Truncate texts if max_tokens is configured
        texts = self._truncate_texts(texts)

        response = self.client.embed(
            model=self.config.model_name_or_path,
            input=texts,
        )
        return response.embeddings
