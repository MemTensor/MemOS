import os
import json
import time
from fastapi import APIRouter
from memos import log
from memos.api.product_models import (
    BaseResponse,
    ChatCompleteRequest,
    ChatRequest,
    GetMemoryRequest,
    MemoryCreateRequest,
    MemoryResponse,
    SearchRequest,
    SearchResponse,
    SimpleResponse,
    SuggestionRequest,
    SuggestionResponse,
    UserRegisterRequest,
    UserRegisterResponse,
)
from memos.configs.embedder import UniversalAPIEmbedderConfig
from memos.configs.graph_db import NebulaGraphDBConfig
from memos.configs.llm import OpenAILLMConfig
from memos.embedders.universal_api import UniversalAPIEmbedder
from memos.graph_dbs.nebular import NebulaGraphDB
from memos.llms.openai import OpenAILLM
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.reranker.cosine_local import CosineLocalReranker
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.configs.chunker import ChunkerConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.chunker import SentenceChunkerConfig
from memos.chunkers.sentence_chunker import SentenceChunker

logger = log.get_logger(__name__)
router = APIRouter()

def init_model():
    llm = OpenAILLM(
        OpenAILLMConfig(model_schema='memos.configs.llm.OpenAILLMConfig', model_name_or_path='gpt-4o',
                        temperature=0.8, max_tokens=1024, top_p=0.9, top_k=50, remove_think_prefix=True,
                        api_key=os.getenv('OPENAI_API_KEY'),
                        api_base=os.getenv('OPENAI_API_BASE'), extra_body=None))
    embedder = UniversalAPIEmbedder(
        UniversalAPIEmbedderConfig(model_schema='memos.configs.embedder.UniversalAPIEmbedderConfig',
                                model_name_or_path='bge-m3', embedding_dims=None, provider='openai',
                                api_key='EMPTY', base_url=os.getenv('MOS_EMBEDDER_API_BASE')))

    reranker = CosineLocalReranker(level_weights={"topic": 1.0, "concept": 1.0, "fact": 1.0}, level_field='background')

    graph_store = NebulaGraphDB(
        NebulaGraphDBConfig(model_schema='memos.configs.graph_db.NebulaGraphDBConfig',
                            uri=json.loads(os.getenv('NEBULAR_HOSTS')),
                            user=os.getenv('NEBULAR_USER'), password=os.getenv('NEBULAR_PASSWORD'), space=os.getenv('NEBULAR_SPACE'),
                            auto_create=True, max_client=1000, embedding_dimension=1024))
    search_obj = Searcher(llm, graph_store, embedder, reranker, internet_retriever=None, moscube=False)
    chunker = SentenceChunker(
        SentenceChunkerConfig(
            model_schema='memos.configs.chunker.SentenceChunkerConfig',
            tokenizer_or_token_counter="gpt2",
            chunk_size=512,
            chunk_overlap=128,
            min_sentences_per_chunk=1,
        )
    )
    mem_reader = SimpleStructMemReader(
        llm,
        embedder,
        chunker
    )
    memory_add_obj = MemoryManager(
        graph_store,
        embedder,
        llm,
        memory_size={
                "WorkingMemory": 20,
                "LongTermMemory": 1500,
                "UserMemory": 480,
            },
        is_reorganize=False
    )

    return search_obj, memory_add_obj, mem_reader

search_obj, memory_add_obj, mem_reader = init_model()


@router.post("/search", summary="Search memories", response_model=SearchResponse)
def search_memories(search_req: SearchRequest):
    """Search memories for a specific user."""
    # try:
    # user_id = f"memos{search_req.user_id.replace('-', '')}"
    user_id = search_req.user_id
    res = search_obj.search(query=search_req.query, user_id=user_id, top_k=search_req.top_k
                   , mode="fast", search_filter=None,
                   info={'user_id': user_id, 'session_id': 'root_session', 'chat_history': []})
    res = {"d": res}
    # print(res)
    return SearchResponse(message="Search completed successfully", data=res)


@router.post("/add", summary="add memories", response_model=SearchResponse)
def add_memories(add_req: MemoryCreateRequest):
    """Add memories for a specific user."""
    time_start = time.time()
    
    memories = mem_reader.get_memory(
        [add_req.messages],
        type="chat",
        info={"user_id": add_req.user_id, "session_id": add_req.session_id},)[0]
    logger.info(
        f"time add: get mem_reader time user_id: {add_req.user_id} time is: {time.time() - time_start:.2f}s"
    )
    data = []

    mem_id_list: list[str] = memory_add_obj.add(memories, user_name=add_req.user_id)
    logger.info(f"Added memory for user {add_req.user_id} in session {add_req.session_id}: {mem_id_list}")

    for m_id, m in zip(mem_id_list, memories):
        data.append({'memory': m.memory, 'mem_ids': m_id, 'memory_type': m.metadata.memory_type})
    return SearchResponse(message="Memory added successfully", data=data)
