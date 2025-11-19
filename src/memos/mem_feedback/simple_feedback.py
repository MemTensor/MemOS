from memos import log
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import PolarDBGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.mem_feedback.feedback import MemFeedback
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager


logger = log.get_logger(__name__)


class SimpleMemFeedback(MemFeedback):
    def __init__(
        self,
        llm: OpenAILLM | OllamaLLM | AzureLLM,
        embedder: OllamaEmbedder,
        graph_store: PolarDBGraphDB,
        memory_manager: MemoryManager,
    ):
        self.llm = llm
        self.embedder = embedder
        self.graph_store = graph_store
        self.memory_manager = memory_manager
