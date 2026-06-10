from memos.configs.chunker import SentenceChunkerConfig
from memos.dependency import require_python_package
from memos.log import get_logger

from .base import BaseChunker, Chunk


logger = get_logger(__name__)


class SentenceChunker(BaseChunker):
    """Sentence-based text chunker."""

    @require_python_package(
        import_name="chonkie",
        install_command="pip install chonkie",
        install_link="https://docs.chonkie.ai/python-sdk/getting-started/installation",
    )
    def __init__(self, config: SentenceChunkerConfig):
        from chonkie import SentenceChunker as ChonkieSentenceChunker

        self.config = config

        common_kwargs = {
            "chunk_size": config.chunk_size,
            "chunk_overlap": config.chunk_overlap,
            "min_sentences_per_chunk": config.min_sentences_per_chunk,
        }

        self.chunker, used_kwarg, last_error = self._build_chonkie_chunker(
            ChonkieSentenceChunker, config.tokenizer_or_token_counter, common_kwargs
        )

        # If the configured tokenizer can't be loaded (no tiktoken, no
        # HuggingFace access, etc.), fall back to chonkie's built-in
        # 'character' counter so the chunker still works offline. Note:
        # chunk_size semantics change from token count to character count
        # for fallback runs.
        if self.chunker is None:
            logger.warning(
                f"Tokenizer '{config.tokenizer_or_token_counter}' unavailable "
                f"({last_error!r}); falling back to 'character'"
            )
            self.chunker, used_kwarg, fallback_error = self._build_chonkie_chunker(
                ChonkieSentenceChunker, "character", common_kwargs
            )
            if self.chunker is None:
                raise RuntimeError(
                    "Failed to initialize SentenceChunker: 'character' fallback "
                    f"also rejected by chonkie ({fallback_error!r})."
                ) from last_error

        logger.debug(f"chonkie SentenceChunker initialized via kwarg {used_kwarg!r}")
        logger.info(f"Initialized SentenceChunker with config: {config}")

    @staticmethod
    def _build_chonkie_chunker(chunker_cls, tokenizer_value, common_kwargs):
        """Build a chonkie SentenceChunker, tolerating the 1.4.0 kwarg rename.

        chonkie >=1.4.0 renamed ``tokenizer_or_token_counter`` to ``tokenizer``.
        Try the new keyword first, then the legacy one. Returns
        ``(instance_or_None, used_kwarg_or_None, last_error_or_None)``.
        """
        last_error: Exception | None = None
        for kwarg in ("tokenizer", "tokenizer_or_token_counter"):
            try:
                instance = chunker_cls(**{kwarg: tokenizer_value}, **common_kwargs)
                return instance, kwarg, None
            except (TypeError, AttributeError, ValueError) as e:
                last_error = e
                continue
        return None, None, last_error

    def chunk(self, text: str) -> list[str] | list[Chunk]:
        """Chunk the given text into smaller chunks based on sentences."""
        protected_text, url_map = self.protect_urls(text)
        chonkie_chunks = self.chunker.chunk(protected_text)

        chunks = []
        for c in chonkie_chunks:
            chunk = Chunk(text=c.text, token_count=c.token_count, sentences=c.sentences)
            chunk = self.restore_urls(chunk.text, url_map)
            chunks.append(chunk)

        logger.debug(f"Generated {len(chunks)} chunks from input text")

        return chunks
