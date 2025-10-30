import json
import os
import random as _random
import socket
import time
import traceback

from collections.abc import Iterable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from memos.api.config import APIConfig
from memos.api.product_models import (
    APIADDRequest,
    APIChatCompleteRequest,
    APISearchRequest,
    MemoryResponse,
    SearchResponse,
)
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.configs.mem_scheduler import SchedulerConfigFactory
from memos.configs.reranker import RerankerConfigFactory
from memos.configs.vec_db import VectorDBConfigFactory
from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_cube.navie import NaiveMemCube
from memos.mem_os.product_server import MOSServer
from memos.mem_reader.factory import MemReaderFactory
from memos.mem_scheduler.orm_modules.base_model import BaseDBManager
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.mem_scheduler.schemas.general_schemas import (
    ADD_LABEL,
    MEM_READ_LABEL,
    PREF_ADD_LABEL,
    SearchMode,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.memories.textual.prefer_text_memory.config import (
    AdderConfigFactory,
    ExtractorConfigFactory,
    RetrieverConfigFactory,
)
from memos.memories.textual.prefer_text_memory.factory import (
    AdderFactory,
    ExtractorFactory,
    RetrieverFactory,
)
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
    InternetRetrieverFactory,
)
from memos.reranker.factory import RerankerFactory
from memos.templates.instruction_completion import instruct_completion


if TYPE_CHECKING:
    from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
from memos.types import MOSSearchResult, UserContext
from memos.vec_dbs.factory import VecDBFactory


logger = get_logger(__name__)

router = APIRouter(prefix="/product", tags=["Server API"])
INSTANCE_ID = f"{socket.gethostname()}:{os.getpid()}:{_random.randint(1000, 9999)}"


def _to_iter(running: Any) -> Iterable:
    """Normalize running tasks to an iterable of task objects."""
    if running is None:
        return []
    if isinstance(running, dict):
        return running.values()
    return running  # assume it's already an iterable (e.g., list)


def _build_graph_db_config(user_id: str = "default") -> dict[str, Any]:
    """Build graph database configuration."""
    graph_db_backend_map = {
        "neo4j-community": APIConfig.get_neo4j_community_config(user_id=user_id),
        "neo4j": APIConfig.get_neo4j_config(user_id=user_id),
        "nebular": APIConfig.get_nebular_config(user_id=user_id),
        "polardb": APIConfig.get_polardb_config(user_id=user_id),
    }

    graph_db_backend = os.getenv("NEO4J_BACKEND", "nebular").lower()
    return GraphDBConfigFactory.model_validate(
        {
            "backend": graph_db_backend,
            "config": graph_db_backend_map[graph_db_backend],
        }
    )


def _build_vec_db_config() -> dict[str, Any]:
    """Build vector database configuration."""
    return VectorDBConfigFactory.model_validate(
        {
            "backend": "milvus",
            "config": APIConfig.get_milvus_config(),
        }
    )


def _build_llm_config() -> dict[str, Any]:
    """Build LLM configuration."""
    return LLMConfigFactory.model_validate(
        {
            "backend": "openai",
            "config": APIConfig.get_openai_config(),
        }
    )


def _build_embedder_config() -> dict[str, Any]:
    """Build embedder configuration."""
    return EmbedderConfigFactory.model_validate(APIConfig.get_embedder_config())


def _build_mem_reader_config() -> dict[str, Any]:
    """Build memory reader configuration."""
    return MemReaderConfigFactory.model_validate(
        APIConfig.get_product_default_config()["mem_reader"]
    )


def _build_reranker_config() -> dict[str, Any]:
    """Build reranker configuration."""
    return RerankerConfigFactory.model_validate(APIConfig.get_reranker_config())


def _build_internet_retriever_config() -> dict[str, Any]:
    """Build internet retriever configuration."""
    return InternetRetrieverConfigFactory.model_validate(APIConfig.get_internet_config())


def _build_pref_extractor_config() -> dict[str, Any]:
    """Build extractor configuration."""
    return ExtractorConfigFactory.model_validate({"backend": "naive", "config": {}})


def _build_pref_adder_config() -> dict[str, Any]:
    """Build adder configuration."""
    return AdderConfigFactory.model_validate({"backend": "naive", "config": {}})


def _build_pref_retriever_config() -> dict[str, Any]:
    """Build retriever configuration."""
    return RetrieverConfigFactory.model_validate({"backend": "naive", "config": {}})


def _get_default_memory_size(cube_config) -> dict[str, int]:
    """Get default memory size configuration."""
    return getattr(cube_config.text_mem.config, "memory_size", None) or {
        "WorkingMemory": 20,
        "LongTermMemory": 1500,
        "UserMemory": 480,
    }


def init_server():
    """Initialize server components and configurations."""
    # Get default cube configuration
    default_cube_config = APIConfig.get_default_cube_config()

    # Build component configurations
    graph_db_config = _build_graph_db_config()
    llm_config = _build_llm_config()
    embedder_config = _build_embedder_config()
    mem_reader_config = _build_mem_reader_config()
    reranker_config = _build_reranker_config()
    internet_retriever_config = _build_internet_retriever_config()
    vector_db_config = _build_vec_db_config()
    pref_extractor_config = _build_pref_extractor_config()
    pref_adder_config = _build_pref_adder_config()
    pref_retriever_config = _build_pref_retriever_config()

    # Create component instances
    graph_db = GraphStoreFactory.from_config(graph_db_config)
    vector_db = VecDBFactory.from_config(vector_db_config)
    llm = LLMFactory.from_config(llm_config)
    embedder = EmbedderFactory.from_config(embedder_config)
    mem_reader = MemReaderFactory.from_config(mem_reader_config)
    reranker = RerankerFactory.from_config(reranker_config)
    internet_retriever = InternetRetrieverFactory.from_config(
        internet_retriever_config, embedder=embedder
    )
    pref_extractor = ExtractorFactory.from_config(
        config_factory=pref_extractor_config,
        llm_provider=llm,
        embedder=embedder,
        vector_db=vector_db,
    )
    pref_adder = AdderFactory.from_config(
        config_factory=pref_adder_config,
        llm_provider=llm,
        embedder=embedder,
        vector_db=vector_db,
    )
    pref_retriever = RetrieverFactory.from_config(
        config_factory=pref_retriever_config,
        llm_provider=llm,
        embedder=embedder,
        reranker=reranker,
        vector_db=vector_db,
    )

    # Initialize memory manager
    memory_manager = MemoryManager(
        graph_db,
        embedder,
        llm,
        memory_size=_get_default_memory_size(default_cube_config),
        is_reorganize=getattr(default_cube_config.text_mem.config, "reorganize", False),
    )
    mos_server = MOSServer(
        mem_reader=mem_reader,
        llm=llm,
        online_bot=False,
    )

    naive_mem_cube = NaiveMemCube(
        llm=llm,
        embedder=embedder,
        mem_reader=mem_reader,
        graph_db=graph_db,
        reranker=reranker,
        internet_retriever=internet_retriever,
        memory_manager=memory_manager,
        default_cube_config=default_cube_config,
        vector_db=vector_db,
        pref_extractor=pref_extractor,
        pref_adder=pref_adder,
        pref_retriever=pref_retriever,
    )

    # Initialize Scheduler
    scheduler_config_dict = APIConfig.get_scheduler_config()
    scheduler_config = SchedulerConfigFactory(
        backend="optimized_scheduler", config=scheduler_config_dict
    )
    mem_scheduler: OptimizedScheduler = SchedulerFactory.from_config(scheduler_config)
    mem_scheduler.initialize_modules(
        chat_llm=llm,
        process_llm=mem_reader.llm,
        db_engine=BaseDBManager.create_default_sqlite_engine(),
        mem_reader=mem_reader,
    )
    mem_scheduler.current_mem_cube = naive_mem_cube
    mem_scheduler.start()

    # Initialize SchedulerAPIModule
    api_module = mem_scheduler.api_module

    return (
        graph_db,
        mem_reader,
        llm,
        embedder,
        reranker,
        internet_retriever,
        memory_manager,
        default_cube_config,
        mos_server,
        mem_scheduler,
        naive_mem_cube,
        api_module,
        vector_db,
        pref_extractor,
        pref_adder,
        pref_retriever,
    )


# Initialize global components
(
    graph_db,
    mem_reader,
    llm,
    embedder,
    reranker,
    internet_retriever,
    memory_manager,
    default_cube_config,
    mos_server,
    mem_scheduler,
    naive_mem_cube,
    api_module,
    vector_db,
    pref_extractor,
    pref_adder,
    pref_retriever,
) = init_server()


def _format_memory_item(memory_data: Any) -> dict[str, Any]:
    """Format a single memory item for API response."""
    memory = memory_data.model_dump()
    memory_id = memory["id"]
    ref_id = f"[{memory_id.split('-')[0]}]"

    memory["ref_id"] = ref_id
    memory["metadata"]["embedding"] = []
    memory["metadata"]["sources"] = []
    memory["metadata"]["ref_id"] = ref_id
    memory["metadata"]["id"] = memory_id
    memory["metadata"]["memory"] = memory["memory"]

    return memory


def _post_process_pref_mem(
    memories_result: list[dict[str, Any]],
    pref_formatted_mem: list[dict[str, Any]],
    mem_cube_id: str,
    handle_pref_mem: bool,
):
    if handle_pref_mem:
        memories_result["pref_mem"].append(
            {
                "cube_id": mem_cube_id,
                "memories": pref_formatted_mem,
            }
        )
        pref_instruction: str = instruct_completion(pref_formatted_mem)
        memories_result["pref_string"] = pref_instruction

    return memories_result


@router.post("/search", summary="Search memories", response_model=SearchResponse)
def search_memories(search_req: APISearchRequest):
    """Search memories for a specific user."""
    # Create UserContext object - how to assign values
    user_context = UserContext(
        user_id=search_req.user_id,
        mem_cube_id=search_req.mem_cube_id,
        session_id=search_req.session_id or "default_session",
    )
    logger.info(f"Search user_id is: {user_context.mem_cube_id}")
    memories_result: MOSSearchResult = {
        "text_mem": [],
        "act_mem": [],
        "para_mem": [],
        "pref_mem": [],
        "pref_string": "",
    }

    search_mode = search_req.mode

    def _search_text():
        if search_mode == SearchMode.FAST:
            formatted_memories = fast_search_memories(
                search_req=search_req, user_context=user_context
            )
        elif search_mode == SearchMode.FINE:
            formatted_memories = fine_search_memories(
                search_req=search_req, user_context=user_context
            )
        elif search_mode == SearchMode.MIXTURE:
            formatted_memories = mix_search_memories(
                search_req=search_req, user_context=user_context
            )
        else:
            logger.error(f"Unsupported search mode: {search_mode}")
            raise HTTPException(status_code=400, detail=f"Unsupported search mode: {search_mode}")
        return formatted_memories

    def _search_pref():
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
            return []
        results = naive_mem_cube.pref_mem.search(
            query=search_req.query,
            top_k=search_req.top_k,
            info={
                "user_id": search_req.user_id,
                "session_id": search_req.session_id,
                "chat_history": search_req.chat_history,
            },
        )
        return [_format_memory_item(data) for data in results]

    with ContextThreadPoolExecutor(max_workers=2) as executor:
        text_future = executor.submit(_search_text)
        pref_future = executor.submit(_search_pref)
        text_formatted_memories = text_future.result()
        pref_formatted_memories = pref_future.result()

    memories_result["text_mem"].append(
        {
            "cube_id": search_req.mem_cube_id,
            "memories": text_formatted_memories,
        }
    )

    memories_result = _post_process_pref_mem(
        memories_result, pref_formatted_memories, search_req.mem_cube_id, search_req.handle_pref_mem
    )

    return SearchResponse(
        message="Search completed successfully",
        data=memories_result,
    )


def mix_search_memories(
    search_req: APISearchRequest,
    user_context: UserContext,
):
    """
    Mix search memories: fast search + async fine search
    """

    formatted_memories = mem_scheduler.mix_search_memories(
        search_req=search_req,
        user_context=user_context,
    )
    return formatted_memories


def fine_search_memories(
    search_req: APISearchRequest,
    user_context: UserContext,
):
    target_session_id = search_req.session_id
    if not target_session_id:
        target_session_id = "default_session"
    search_filter = {"session_id": search_req.session_id} if search_req.session_id else None

    # Create MemCube and perform search
    search_results = naive_mem_cube.text_mem.search(
        query=search_req.query,
        user_name=user_context.mem_cube_id,
        top_k=search_req.top_k,
        mode=SearchMode.FINE,
        manual_close_internet=not search_req.internet_search,
        moscube=search_req.moscube,
        search_filter=search_filter,
        info={
            "user_id": search_req.user_id,
            "session_id": target_session_id,
            "chat_history": search_req.chat_history,
        },
    )
    formatted_memories = [_format_memory_item(data) for data in search_results]

    return formatted_memories


def fast_search_memories(
    search_req: APISearchRequest,
    user_context: UserContext,
):
    target_session_id = search_req.session_id
    if not target_session_id:
        target_session_id = "default_session"
    search_filter = {"session_id": search_req.session_id} if search_req.session_id else None

    # Create MemCube and perform search
    search_results = naive_mem_cube.text_mem.search(
        query=search_req.query,
        user_name=user_context.mem_cube_id,
        top_k=search_req.top_k,
        mode=SearchMode.FAST,
        manual_close_internet=not search_req.internet_search,
        moscube=search_req.moscube,
        search_filter=search_filter,
        info={
            "user_id": search_req.user_id,
            "session_id": target_session_id,
            "chat_history": search_req.chat_history,
        },
    )
    formatted_memories = [_format_memory_item(data) for data in search_results]

    return formatted_memories


@router.post("/add", summary="Add memories", response_model=MemoryResponse)
def add_memories(add_req: APIADDRequest):
    """Add memories for a specific user."""
    # Create UserContext object - how to assign values
    user_context = UserContext(
        user_id=add_req.user_id,
        mem_cube_id=add_req.mem_cube_id,
        session_id=add_req.session_id or "default_session",
    )
    target_session_id = add_req.session_id
    if not target_session_id:
        target_session_id = "default_session"

    # If text memory backend works in async mode, submit tasks to scheduler
    try:
        sync_mode = getattr(naive_mem_cube.text_mem, "mode", "sync")
    except Exception:
        sync_mode = "sync"
    logger.info(f"Add sync_mode mode is: {sync_mode}")

    def _process_text_mem() -> list[dict[str, str]]:
        memories_local = mem_reader.get_memory(
            [add_req.messages],
            type="chat",
            info={
                "user_id": add_req.user_id,
                "session_id": target_session_id,
            },
            mode="fast" if sync_mode == "async" else "fine",
        )
        flattened_local = [mm for m in memories_local for mm in m]
        logger.info(f"Memory extraction completed for user {add_req.user_id}")
        mem_ids_local: list[str] = naive_mem_cube.text_mem.add(
            flattened_local,
            user_name=user_context.mem_cube_id,
        )
        logger.info(
            f"Added {len(mem_ids_local)} memories for user {add_req.user_id} "
            f"in session {add_req.session_id}: {mem_ids_local}"
        )
        if sync_mode == "async":
            try:
                message_item_read = ScheduleMessageItem(
                    user_id=add_req.user_id,
                    session_id=target_session_id,
                    mem_cube_id=add_req.mem_cube_id,
                    mem_cube=naive_mem_cube,
                    label=MEM_READ_LABEL,
                    content=json.dumps(mem_ids_local),
                    timestamp=datetime.utcnow(),
                    user_name=add_req.mem_cube_id,
                )
                mem_scheduler.submit_messages(messages=[message_item_read])
                logger.info(f"2105Submit messages!!!!!: {json.dumps(mem_ids_local)}")
            except Exception as e:
                logger.error(f"Failed to submit async memory tasks: {e}", exc_info=True)
        else:
            message_item_add = ScheduleMessageItem(
                user_id=add_req.user_id,
                session_id=target_session_id,
                mem_cube_id=add_req.mem_cube_id,
                mem_cube=naive_mem_cube,
                label=ADD_LABEL,
                content=json.dumps(mem_ids_local),
                timestamp=datetime.utcnow(),
                user_name=add_req.mem_cube_id,
            )
            mem_scheduler.submit_messages(messages=[message_item_add])
        return [
            {
                "memory": memory.memory,
                "memory_id": memory_id,
                "memory_type": memory.metadata.memory_type,
            }
            for memory_id, memory in zip(mem_ids_local, flattened_local, strict=False)
        ]

    def _process_pref_mem() -> list[dict[str, str]]:
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
            return []
        # Follow async behavior similar to core.py: enqueue when async
        if sync_mode == "async":
            try:
                messages_list = [add_req.messages]
                message_item_pref = ScheduleMessageItem(
                    user_id=add_req.user_id,
                    session_id=target_session_id,
                    mem_cube_id=add_req.mem_cube_id,
                    mem_cube=naive_mem_cube,
                    label=PREF_ADD_LABEL,
                    content=json.dumps(messages_list),
                    timestamp=datetime.utcnow(),
                )
                mem_scheduler.submit_messages(messages=[message_item_pref])
                logger.info("Submitted preference add to scheduler (async mode)")
            except Exception as e:
                logger.error(f"Failed to submit PREF_ADD task: {e}", exc_info=True)
            return []
        else:
            pref_memories_local = naive_mem_cube.pref_mem.get_memory(
                [add_req.messages],
                type="chat",
                info={
                    "user_id": add_req.user_id,
                    "session_id": target_session_id,
                },
            )
            pref_ids_local: list[str] = naive_mem_cube.pref_mem.add(pref_memories_local)
            logger.info(
                f"Added {len(pref_ids_local)} preferences for user {add_req.user_id} "
                f"in session {add_req.session_id}: {pref_ids_local}"
            )
            return [
                {
                    "memory": memory.memory,
                    "memory_id": memory_id,
                    "memory_type": memory.metadata.preference_type,
                }
                for memory_id, memory in zip(pref_ids_local, pref_memories_local, strict=False)
            ]

    with ContextThreadPoolExecutor(max_workers=2) as executor:
        text_future = executor.submit(_process_text_mem)
        pref_future = executor.submit(_process_pref_mem)
        text_response_data = text_future.result()
        pref_response_data = pref_future.result()

    return MemoryResponse(
        message="Memory added successfully",
        data=text_response_data + pref_response_data,
    )


@router.get("/scheduler/status", summary="Get scheduler running status")
def scheduler_status(user_name: str | None = None):
    try:
        if user_name:
            running = mem_scheduler.dispatcher.get_running_tasks(
                lambda task: getattr(task, "mem_cube_id", None) == user_name
            )
            tasks_iter = list(_to_iter(running))
            running_count = len(tasks_iter)
            return {
                "message": "ok",
                "data": {
                    "scope": "user",
                    "user_name": user_name,
                    "running_tasks": running_count,
                    "timestamp": time.time(),
                    "instance_id": INSTANCE_ID,
                },
            }
        else:
            running_all = mem_scheduler.dispatcher.get_running_tasks(lambda _t: True)
            tasks_iter = list(_to_iter(running_all))
            running_count = len(tasks_iter)

            task_count_per_user: dict[str, int] = {}
            for task in tasks_iter:
                cube = getattr(task, "mem_cube_id", "unknown")
                task_count_per_user[cube] = task_count_per_user.get(cube, 0) + 1

            return {
                "message": "ok",
                "data": {
                    "scope": "global",
                    "running_tasks": running_count,
                    "task_count_per_user": task_count_per_user,
                    "timestamp": time.time(),
                    "instance_id": INSTANCE_ID,
                },
            }
    except Exception as err:
        logger.error("Failed to get scheduler status: %s", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Failed to get scheduler status") from err


@router.post("/scheduler/wait", summary="Wait until scheduler is idle for a specific user")
def scheduler_wait(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.2,
):
    """
    Block until scheduler has no running tasks for the given user_name, or timeout.
    """
    start = time.time()
    try:
        while True:
            running = mem_scheduler.dispatcher.get_running_tasks(
                lambda task: task.mem_cube_id == user_name
            )
            running_count = len(running)
            elapsed = time.time() - start

            # success -> scheduler is idle
            if running_count == 0:
                return {
                    "message": "idle",
                    "data": {
                        "running_tasks": 0,
                        "waited_seconds": round(elapsed, 3),
                        "timed_out": False,
                        "user_name": user_name,
                    },
                }

            # timeout check
            if elapsed > timeout_seconds:
                return {
                    "message": "timeout",
                    "data": {
                        "running_tasks": running_count,
                        "waited_seconds": round(elapsed, 3),
                        "timed_out": True,
                        "user_name": user_name,
                    },
                }

            time.sleep(poll_interval)

    except Exception as err:
        logger.error("Failed while waiting for scheduler: %s", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Failed while waiting for scheduler") from err


@router.get("/scheduler/wait/stream", summary="Stream scheduler progress for a user")
def scheduler_wait_stream(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.2,
):
    """
    Stream scheduler progress via Server-Sent Events (SSE).

    Contract:
    - We emit periodic heartbeat frames while tasks are still running.
    - Each heartbeat frame is JSON, prefixed with "data: ".
    - On final frame, we include status = "idle" or "timeout" and timed_out flag,
      with the same semantics as /scheduler/wait.

    Example curl:
      curl -N "${API_HOST}/product/scheduler/wait/stream?timeout_seconds=10&poll_interval=0.5"
    """

    def event_generator():
        start = time.time()
        try:
            while True:
                running = mem_scheduler.dispatcher.get_running_tasks(
                    lambda task: task.mem_cube_id == user_name
                )
                running_count = len(running)
                elapsed = time.time() - start

                payload = {
                    "user_name": user_name,
                    "running_tasks": running_count,
                    "elapsed_seconds": round(elapsed, 3),
                    "status": "running" if running_count > 0 else "idle",
                    "instance_id": INSTANCE_ID,
                }
                yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

                if running_count == 0 or elapsed > timeout_seconds:
                    payload["status"] = "idle" if running_count == 0 else "timeout"
                    payload["timed_out"] = running_count > 0
                    yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                    break

                time.sleep(poll_interval)

        except Exception as e:
            err_payload = {
                "status": "error",
                "detail": "stream_failed",
                "exception": str(e),
                "user_name": user_name,
            }
            logger.error(f"Scheduler stream error for {user_name}: {traceback.format_exc()}")
            yield "data: " + json.dumps(err_payload, ensure_ascii=False) + "\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/chat/complete", summary="Chat with MemOS (Complete Response)")
def chat_complete(chat_req: APIChatCompleteRequest):
    """Chat with MemOS for a specific user. Returns complete response (non-streaming)."""
    try:
        # Collect all responses from the generator
        content, references = mos_server.chat(
            query=chat_req.query,
            user_id=chat_req.user_id,
            cube_id=chat_req.mem_cube_id,
            mem_cube=naive_mem_cube,
            history=chat_req.history,
            internet_search=chat_req.internet_search,
            moscube=chat_req.moscube,
            base_prompt=chat_req.base_prompt,
            top_k=chat_req.top_k,
            threshold=chat_req.threshold,
            session_id=chat_req.session_id,
        )

        # Return the complete response
        return {
            "message": "Chat completed successfully",
            "data": {"response": content, "references": references},
        }

    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(traceback.format_exc())) from err
    except Exception as err:
        logger.error(f"Failed to start chat: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(traceback.format_exc())) from err
