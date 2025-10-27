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
        self.chunker = ChonkieSentenceChunker(
            tokenizer_or_token_counter=config.tokenizer_or_token_counter,
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
            min_sentences_per_chunk=config.min_sentences_per_chunk,
        )
        logger.info(f"Initialized SentenceChunker with config: {config}")

    def chunk(self, text: str) -> list[str] | list[Chunk]:
        """Chunk the given text into smaller chunks based on sentences."""
        chonkie_chunks = self.chunker.chunk(text)

        chunks = []
        for c in chonkie_chunks:
            chunk = Chunk(text=c.text, token_count=c.token_count, sentences=c.sentences)
            chunks.append(chunk)

        logger.debug(f"Generated {len(chunks)} chunks from input text")
        return chunks
