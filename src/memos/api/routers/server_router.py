from memos.api.config import APIConfig
from memos.api.product_models import (
    APIMemoryADDRequest,
    MemoryResponse,
    SearchResponse,
)
from memos.log import get_logger
from memos.mem_cube.navie import NaiveMemCube
from memos.mem_reader.factory import MemReaderFactory
from memos.types import MOSSearchResult


logger = get_logger(__name__)


def init_mem_cube():
    default_cube_config = APIConfig.get_default_cube_config()
    mos_config = APIConfig.get_product_default_config()
    mem_reader = MemReaderFactory.from_config(mos_config["mem_reader"])
    naive_mem_cube = NaiveMemCube(default_cube_config)
    return naive_mem_cube, mem_reader


naive_mem_cube, mem_reader = init_mem_cube()


@router.post("/search", summary="Search memories", response_model=SearchResponse)
def search_memories(search_req: APIMemoryADDRequest):
    """Search memories for a specific user."""
    memories_result: MOSSearchResult = {
        "text_mem": [],
        "act_mem": [],
        "para_mem": [],
    }
    search_filter = None
    target_session_id = (
        search_req.session_id if search_req.session_id is not None else "default_session"
    )
    if search_req.session_id is not None:
        search_filter = {"session_id": search_req.session_id}
    memories_list = naive_mem_cube.search(
        query=search_req.query,
        user_id=search_req.mem_cube_id,
        top_k=search_req.top_k,
        mode=search_req.mode,
        internet_search=not search_req.internet_search,
        moscube=search_req.moscube,
        search_filter=search_filter,
        info={
            "user_id": search_req.mem_cube_id,
            "session_id": target_session_id,
            "chat_history": search_req.chat_history,
        },
    )
    memories_list = []
    for data in memories_list:
        memories = data.model_dump()
        memories["ref_id"] = f"[{memories['id'].split('-')[0]}]"
        memories["metadata"]["embedding"] = []
        memories["metadata"]["sources"] = []
        memories["metadata"]["ref_id"] = f"[{memories['id'].split('-')[0]}]"
        memories["metadata"]["id"] = memories["id"]
        memories["metadata"]["memory"] = memories["memory"]
        memories_list.append(memories)
    memories_result["text_mem"].append(
        {"cube_id": search_req.mem_cube_id, "memories": memories_list}
    )
    return SearchResponse(message="Search completed successfully", data=memories_result)


@router.post("/add", summary="add memories", response_model=MemoryResponse)
def add_memories(add_req: APIMemoryADDRequest):
    """Add memories for a specific user."""
    time_start = time.time()
    memories = mem_reader.get_memory(
        [add_req.messages],
        type="chat",
        info={"user_id": add_req.user_id, "session_id": add_req.session_id},
    )
    memories = [mm for m in memories for mm in m]
    logger.info(
        f"time add: get mem_reader time user_id: {add_req.user_id} time is: {time.time() - time_start:.2f}s"
    )
    mem_id_list: list[str] = memory_add_obj.add(memories, user_name=add_req.user_id)
    logger.info(
        f"Added memory for user {add_req.user_id} in session {add_req.session_id}: {mem_id_list}"
    )
    data = []
    for m_id, m in zip(mem_id_list, memories, strict=False):
        data.append({"memory": m.memory, "memory_id": m_id, "memory_type": m.metadata.memory_type})
    return MemoryResponse(message="Memory added successfully", data=data)
