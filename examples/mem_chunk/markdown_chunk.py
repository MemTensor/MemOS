from memos.chunkers import ChunkerFactory
from memos.configs.chunker import ChunkerConfigFactory


config = ChunkerConfigFactory.model_validate(
    {
        "backend": "markdown",
        "config": {
            "chunk_size": 1000,
            "chunk_overlap": 100,
            "recursive": True,
        },
    }
)

chunker = ChunkerFactory.from_config(config)

text = """
# Header 1
This is the first sentence. This is the second sentence.
And here's a third one with some additional context.

# Header 2
This is the fourth sentence. This is the fifth sentence.
And here's a sixth one with some additional context.

# Header 3
This is the seventh sentence. This is the eighth sentence.
And here's a ninth one with some additional context.
"""
chunks = chunker.chunk(text)
for chunk in chunks:
    print("doc:", chunk)
