import os

from openai import AzureOpenAI as AzureClient
from openai import BadRequestError
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

    @staticmethod
    def _build_embedding_kwargs(model: str, texts: list[str], embedding_dims: int | None) -> dict:
        kwargs = {"model": model, "input": texts}
        if embedding_dims is not None:
            kwargs["dimensions"] = embedding_dims
        return kwargs

    @staticmethod
    def _is_dimensions_unsupported(error: BadRequestError) -> bool:
        body = getattr(error, "body", None)
        details = body.get("error", body) if isinstance(body, dict) else {}
        if isinstance(details, dict):
            param = str(details.get("param") or "").lower()
            code = str(details.get("code") or "").lower()
            if param == "dimensions" and any(
                marker in code for marker in ("unsupported", "unknown", "unrecognized")
            ):
                return True

        messages = [str(error)]
        if isinstance(details, dict) and isinstance(details.get("message"), str):
            messages.append(details["message"])
        message = " ".join(messages).lower()
        unsupported_markers = (
            "dimensions is not supported",
            "dimensions not supported",
            "does not support dimensions",
            "unsupported parameter: dimensions",
            "unknown parameter: dimensions",
            "does not support matryoshka",
            "changing output dimensions is unsupported",
            "changing output dimensions will lead",
        )
        return any(marker in message for marker in unsupported_markers)

    def _call_embeddings_api(
        self, client, model: str, texts: list[str], timeout: int
    ) -> list[list[float]]:
        embedding_dims = getattr(self.config, "embedding_dims", None)
        kwargs = self._build_embedding_kwargs(model, texts, embedding_dims)

        try:
            response = client.embeddings.create(**kwargs, timeout=timeout)
        except BadRequestError as error:
            if embedding_dims is None or not self._is_dimensions_unsupported(error):
                raise

            logger.warning(
                "Embedding provider rejected dimensions=%d; retrying without dimensions",
                embedding_dims,
            )
            fallback_kwargs = self._build_embedding_kwargs(model, texts, None)
            response = client.embeddings.create(**fallback_kwargs, timeout=timeout)

        return [item.embedding for item in response.data]

    @log_embedding_call
    def embed(self, texts: list[str]) -> list[list[float]]:
        if isinstance(texts, str):
            texts = [texts]
        texts = [_sanitize_unicode(t) for t in texts]
        texts = self._truncate_texts(texts)
        if self.provider == "openai" or self.provider == "azure":
            timeout = int(os.getenv("MOS_EMBEDDER_TIMEOUT", 5))
            try:
                model = getattr(self.config, "model_name_or_path", "text-embedding-3-large")
                return self._call_embeddings_api(self.client, model, texts, timeout)
            except Exception as e:
                if self.use_backup_client:
                    logger.warning(
                        "Embedding request failed error_type=%s; trying backup client",
                        type(e).__name__,
                    )
                    try:
                        backup_model = getattr(
                            self.config,
                            "backup_model_name_or_path",
                            "text-embedding-3-large",
                        )
                        return self._call_embeddings_api(
                            self.backup_client, backup_model, texts, timeout
                        )
                    except Exception as e_backup:
                        raise ValueError(
                            f"Backup embeddings request ended with error: {e_backup}"
                        ) from e_backup
                else:
                    raise ValueError(f"Embeddings request ended with error: {e}") from e
        else:
            raise ValueError(f"Embeddings unsupported provider: {self.provider}")
