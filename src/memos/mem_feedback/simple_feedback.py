from memos import log
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import PolarDBGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.mem_feedback.feedback import MemFeedback
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import StopwordManager
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.base import BaseReranker


logger = log.get_logger(__name__)


class SimpleMemFeedback(MemFeedback):
    def __init__(
        self,
        llm: OpenAILLM | OllamaLLM | AzureLLM,
        embedder: OllamaEmbedder,
        graph_store: PolarDBGraphDB,
        memory_manager: MemoryManager,
        mem_reader: SimpleStructMemReader,
        searcher: Searcher,
        reranker: BaseReranker,
    ):
        self.llm = llm
        self.embedder = embedder
        self.graph_store = graph_store
        self.memory_manager = memory_manager
        self.mem_reader = mem_reader
        self.searcher = searcher
        self.stopword_manager = StopwordManager
        self.reranker = reranker
        self.DB_IDX_READY = False
