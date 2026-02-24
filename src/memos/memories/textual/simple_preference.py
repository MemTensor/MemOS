from memos.embedders.factory import (
    ArkEmbedder,
    OllamaEmbedder,
    SenTranEmbedder,
    UniversalAPIEmbedder,
)
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.preference import PreferenceTextMemory
from memos.vec_dbs.factory import MilvusVecDB, QdrantVecDB


logger = get_logger(__name__)


class SimplePreferenceTextMemory(PreferenceTextMemory):
    """Preference textual memory implementation for storing and retrieving memories."""

    def __init__(
        self,
        extractor_llm: OpenAILLM | OllamaLLM | AzureLLM,
        vector_db: MilvusVecDB | QdrantVecDB,
        embedder: OllamaEmbedder | ArkEmbedder | SenTranEmbedder | UniversalAPIEmbedder,
        reranker,
        extractor,
        adder,
        retriever,
    ):
        """Initialize memory with the given configuration."""
        self.extractor_llm = extractor_llm
        self.vector_db = vector_db
        self.embedder = embedder
        self.reranker = reranker
        self.extractor = extractor
        self.adder = adder
        self.retriever = retriever
