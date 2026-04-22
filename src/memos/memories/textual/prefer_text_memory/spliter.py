import copy

from memos.chunkers import ChunkerFactory
from memos.configs.chunker import ChunkerConfigFactory
from memos.configs.parser import ParserConfigFactory
from memos.parsers.factory import ParserFactory
from memos.types import MessageList


class Splitter:
    """Splitter."""

    def __init__(
        self,
        lookback_turns: int = 1,
        chunk_size: int = 256,
        chunk_overlap: int = 128,
        min_sentences_per_chunk: int = 1,
        tokenizer: str = "gpt2",
        parser_backend: str = "markitdown",
        chunker_backend: str = "sentence",
    ):
        """Initialize the splitter."""
        self.lookback_turns = lookback_turns
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_sentences_per_chunk = min_sentences_per_chunk
        self.tokenizer = tokenizer
        self.chunker_backend = chunker_backend
        self.parser_backend = parser_backend
        # Initialize parser
        parser_config = ParserConfigFactory.model_validate(
            {
                "backend": self.parser_backend,
                "config": {},
            }
        )
        self.parser = ParserFactory.from_config(parser_config)

        # Initialize chunker
        chunker_config = ChunkerConfigFactory.model_validate(
            {
                "backend": self.chunker_backend,
                "config": {
                    "tokenizer_or_token_counter": self.tokenizer,
                    "chunk_size": self.chunk_size,
                    "chunk_overlap": self.chunk_overlap,
                    "min_sentences_per_chunk": self.min_sentences_per_chunk,
                },
            }
        )
        self.chunker = ChunkerFactory.from_config(chunker_config)

    def _split_with_lookback(self, data: MessageList) -> list[MessageList]:
        """Split the messages or files into chunks by looking back fixed number of turns.
        adjacent chunk with high duplicate rate,
        default lookback turns is 1, only current turn in chunk"""
        # Build QA pairs from chat history
        pairs = self.build_qa_pairs(data)
        chunks = []

        # Create chunks by looking back fixed number of turns
        for i in range(len(pairs)):
            # Calculate the start index for lookback
            start_idx = max(0, i + 1 - self.lookback_turns)
            # Get the chunk of pairs (as many as available, up to lookback_turns)
            chunk_pairs = pairs[start_idx : i + 1]

            # Flatten chunk_pairs (list[list[dict]]) to MessageList (list[dict])
            chunk_messages = []
            for pair in chunk_pairs:
                chunk_messages.extend(pair)

            chunks.append(chunk_messages)
        return chunks

    def _split_with_overlap(self, data: MessageList) -> list[MessageList]:
        """split the messages or files into chunks with overlap.
        adjacent chunk with low duplicate rate"""
        chunks = []
        chunk = []
        for i, item in enumerate(data):
            chunk.append(item)
            # 5 turns (Q + A = 10) each chunk
            if len(chunk) >= 10:
                chunks.append(chunk)
                # overlap 1 turns (Q + A = 2)
                context = copy.deepcopy(chunk[-2:]) if i + 1 < len(data) else []
                chunk = context
        if chunk:
            chunks.append(chunk)

        return chunks

    def split_chunks(self, data: MessageList | str, **kwargs) -> list[MessageList] | list[str]:
        """Split the messages or files into chunks.

        Args:
            data: MessageList or string to split

        Returns:
            List of MessageList chunks or list of string chunks
        """
        if isinstance(data, list):
            if kwargs.get("split_type") == "lookback":
                chunks = self._split_with_lookback(data)
            elif kwargs.get("split_type") == "overlap":
                chunks = self._split_with_overlap(data)
            return chunks
        else:
            # Parse and chunk the string data using pre-initialized components
            text = self.parser.parse(data)
            chunks = self.chunker.chunk(text)

            return [chunk.text for chunk in chunks]

    def build_qa_pairs(self, chat_history: MessageList) -> list[MessageList]:
        """Build QA pairs from chat history."""
        qa_pairs = []
        current_qa_pair = []

        for message in chat_history:
            if message["role"] == "user":
                current_qa_pair.append(message)
            elif message["role"] == "assistant":
                if not current_qa_pair:
                    continue
                current_qa_pair.append(message)
                qa_pairs.append(current_qa_pair.copy())
                current_qa_pair = []  # reset

        return qa_pairs
