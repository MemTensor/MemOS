from memos.configs.embedder import ArkEmbedderConfig
from memos.dependency import require_python_package
from memos.embedders.base import BaseEmbedder
from memos.log import get_logger


logger = get_logger(__name__)


class ArkEmbedder(BaseEmbedder):
    """Ark Embedder class."""

    @require_python_package(
        import_name="volcenginesdkarkruntime",
        install_command="pip install 'volcengine-python-sdk[ark]'",
        install_link="https://www.volcengine.com/docs/82379/1541595",
    )
    def __init__(self, config: ArkEmbedderConfig):
        from volcenginesdkarkruntime import Ark

        self.config = config

        if self.config.embedding_dims is not None:
            logger.warning(
                "Ark does not support specifying embedding dimensions. "
                "The embedding dimensions is determined by the model."
                "`embedding_dims` will be set to None."
            )
            self.config.embedding_dims = None

        # Default model if not specified
        if not self.config.model_name_or_path:
            self.config.model_name_or_path = "doubao-embedding-vision-250615"

        # Initialize ark client
        self.client = Ark(api_key=self.config.api_key, base_url=self.config.api_base)

    def embed(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for the given texts.

        Args:
            texts: List of texts to embed.

        Returns:
            List of embeddings, each represented as a list of floats.
        """
        from volcenginesdkarkruntime.types.multimodal_embedding import (
            MultimodalEmbeddingContentPartTextParam,
        )

        # Truncate texts if max_tokens is configured
        texts = self._truncate_texts(texts)

        if self.config.multi_modal:
            texts_input = [
                MultimodalEmbeddingContentPartTextParam(text=text, type="text") for text in texts
            ]
            return self.multimodal_embeddings(inputs=texts_input, chunk_size=self.config.chunk_size)
        return self.text_embedding(texts, chunk_size=self.config.chunk_size)

    def text_embedding(self, inputs: list[str], chunk_size: int | None = None) -> list[list[float]]:
        chunk_size_ = chunk_size or self.config.chunk_size
        embeddings: list[list[float]] = []
        for i in range(0, len(inputs), chunk_size_):
            response = self.client.embeddings.create(
                model=self.config.model_name_or_path,
                input=inputs[i : i + chunk_size_],
            )

            data = [response.data] if isinstance(response.data, dict) else response.data
            embeddings.extend(r.embedding for r in data)

        return embeddings

    def multimodal_embeddings(
        self, inputs: list, chunk_size: int | None = None
    ) -> list[list[float]]:
        from volcenginesdkarkruntime.types.multimodal_embedding import (
            MultimodalEmbeddingResponse,  # noqa: TC002
        )

        chunk_size_ = chunk_size or self.config.chunk_size
        embeddings: list[list[float]] = []

        for i in range(0, len(inputs), chunk_size_):
            response: MultimodalEmbeddingResponse = self.client.multimodal_embeddings.create(
                model=self.config.model_name_or_path,
                input=inputs[i : i + chunk_size_],
            )

            data = [response.data] if isinstance(response.data, dict) else response.data
            embeddings.extend(r["embedding"] for r in data)

        return embeddings
