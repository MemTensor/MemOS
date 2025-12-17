"""
Chat handler for chat functionality (Class-based version).

This module provides a complete implementation of chat handlers,
consolidating all chat-related logic without depending on mos_server.
"""

import asyncio
import json
import re
import time
import traceback

from collections.abc import Generator
from datetime import datetime
from typing import Any, Literal

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import (
    APIADDRequest,
    APIChatCompleteRequest,
    APISearchRequest,
    ChatPlaygroundRequest,
    ChatRequest,
)
from memos.context.context import ContextThread
from memos.mem_os.utils.format_utils import clean_json_response
from memos.mem_os.utils.reference_utils import (
    prepare_reference_data,
    process_streaming_references_complete,
)
from memos.mem_reader.read_multi_modal.utils import detect_lang
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    ANSWER_TASK_LABEL,
    QUERY_TASK_LABEL,
)
from memos.templates.cloud_service_prompt import get_cloud_chat_prompt
from memos.templates.mos_prompts import (
    FURTHER_SUGGESTION_PROMPT,
    get_memos_prompt,
)
from memos.types import MessageList


class ChatHandler(BaseHandler):
    """
    Handler for chat operations.

    Composes SearchHandler and AddHandler to provide complete chat functionality
    without depending on mos_server. All chat logic is centralized here.
    """

    def __init__(
        self,
        dependencies: HandlerDependencies,
        chat_llms: dict[str, Any],
        search_handler=None,
        add_handler=None,
        online_bot=None,
    ):
        """
        Initialize chat handler.

        Args:
            dependencies: HandlerDependencies instance
            chat_llms: Dictionary mapping model names to LLM instances
            search_handler: Optional SearchHandler instance (created if not provided)
            add_handler: Optional AddHandler instance (created if not provided)
            online_bot: Optional DingDing bot function for notifications
        """
        super().__init__(dependencies)
        self._validate_dependencies("llm", "naive_mem_cube", "mem_reader", "mem_scheduler")

        # Lazy import to avoid circular dependencies
        if search_handler is None:
            from memos.api.handlers.search_handler import SearchHandler

            search_handler = SearchHandler(dependencies)

        if add_handler is None:
            from memos.api.handlers.add_handler import AddHandler

            add_handler = AddHandler(dependencies)

        self.chat_llms = chat_llms
        self.search_handler = search_handler
        self.add_handler = add_handler
        self.online_bot = online_bot

        # Check if scheduler is enabled
        self.enable_mem_scheduler = (
            hasattr(dependencies, "enable_mem_scheduler") and dependencies.enable_mem_scheduler
        )
        self.dependencies = dependencies

    def handle_chat_complete(self, chat_req: APIChatCompleteRequest) -> dict[str, Any]:
        """
        Chat with MemOS for complete response (non-streaming).

        This implementation directly uses search/add handlers instead of mos_server.

        Args:
            chat_req: Chat complete request

        Returns:
            Dictionary with response and references

        Raises:
            HTTPException: If chat fails
        """
        try:
            # Resolve readable cube IDs (for search)
            readable_cube_ids = chat_req.readable_cube_ids or [chat_req.user_id]

            # Step 1: Search for relevant memories
            search_req = APISearchRequest(
                query=chat_req.query,
                user_id=chat_req.user_id,
                readable_cube_ids=readable_cube_ids,
                mode=chat_req.mode,
                internet_search=chat_req.internet_search,
                top_k=chat_req.top_k,
                chat_history=chat_req.history,
                session_id=chat_req.session_id,
                include_preference=chat_req.include_preference,
                pref_top_k=chat_req.pref_top_k,
                filter=chat_req.filter,
            )

            search_response = self.search_handler.handle_search_memories(search_req)

            # Extract memories from search results
            memories_list = []
            if search_response.data and search_response.data.get("text_mem"):
                text_mem_results = search_response.data["text_mem"]
                if text_mem_results and text_mem_results[0].get("memories"):
                    memories_list = text_mem_results[0]["memories"]

            # Filter memories by threshold
            filtered_memories = self._filter_memories_by_threshold(
                memories_list, chat_req.threshold or 0.5
            )

            # Step 2: Build system prompt
            system_prompt = self._build_system_prompt(
                query=chat_req.query,
                memories=filtered_memories,
                pref_string=search_response.data.get("pref_string", ""),
                base_prompt=chat_req.system_prompt,
            )

            # Prepare message history
            history_info = chat_req.history[-20:] if chat_req.history else []
            current_messages = [
                {"role": "system", "content": system_prompt},
                *history_info,
                {"role": "user", "content": chat_req.query},
            ]

            self.logger.info("Starting to generate complete response...")

            # Step 3: Generate complete response from LLM
            if chat_req.model_name_or_path and chat_req.model_name_or_path not in self.chat_llms:
                raise HTTPException(
                    status_code=400,
                    detail=f"Model {chat_req.model_name_or_path} not suport, choose from {list(self.chat_llms.keys())}",
                )

            model = chat_req.model_name_or_path or next(iter(self.chat_llms.keys()))

            self.logger.info(f"[Cloud Service Chat Complete Model]: {model}")
            strat = time.time()
            response = self.chat_llms[model].generate(current_messages, model_name_or_path=model)
            end = time.time()
            self.logger.info(f"[Cloud Service Chat Complete Time]: {end - strat} seconds")

            # Step 4: start add after chat asynchronously
            if chat_req.add_message_on_answer:
                # Resolve writable cube IDs (for add)
                writable_cube_ids = chat_req.writable_cube_ids or [chat_req.user_id]
                start = time.time()
                self._start_add_to_memory(
                    user_id=chat_req.user_id,
                    writable_cube_ids=writable_cube_ids,
                    session_id=chat_req.session_id or "default_session",
                    query=chat_req.query,
                    full_response=response,
                    async_mode="async",
                )
                end = time.time()
                self.logger.info(f"[Cloud Service Chat Add Time]: {end - start} seconds")

            match = re.search(r"<think>([\s\S]*?)</think>", response)
            reasoning_text = match.group(1) if match else None
            final_text = (
                re.sub(r"<think>[\s\S]*?</think>", "", response, count=1) if match else response
            )

            return {
                "message": "Chat completed successfully",
                "data": {"response": final_text, "reasoning": reasoning_text},
            }

        except ValueError as err:
            raise HTTPException(status_code=404, detail=str(traceback.format_exc())) from err
        except Exception as err:
            self.logger.error(f"Failed to complete chat: {traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=str(traceback.format_exc())) from err

    def handle_chat_stream(self, chat_req: ChatRequest) -> StreamingResponse:
        """
        Chat with MemOS via Server-Sent Events (SSE) stream using search/add handlers.

        This implementation directly uses search_handler and add_handler.

        Args:
            chat_req: Chat stream request

        Returns:
            StreamingResponse with SSE formatted chat stream

        Raises:
            HTTPException: If stream initialization fails
        """
        try:

            def generate_chat_response() -> Generator[str, None, None]:
                """Generate chat response as SSE stream."""
                try:
                    # Resolve readable cube IDs (for search)
                    readable_cube_ids = chat_req.readable_cube_ids or (
                        [chat_req.mem_cube_id] if chat_req.mem_cube_id else [chat_req.user_id]
                    )

                    search_req = APISearchRequest(
                        query=chat_req.query,
                        user_id=chat_req.user_id,
                        readable_cube_ids=readable_cube_ids,
                        mode=chat_req.mode,
                        internet_search=chat_req.internet_search,
                        top_k=chat_req.top_k,
                        chat_history=chat_req.history,
                        session_id=chat_req.session_id,
                        include_preference=chat_req.include_preference,
                        pref_top_k=chat_req.pref_top_k,
                        filter=chat_req.filter,
                    )

                    search_response = self.search_handler.handle_search_memories(search_req)

                    # Use first readable cube ID for scheduler (backward compatibility)
                    scheduler_cube_id = (
                        readable_cube_ids[0] if readable_cube_ids else chat_req.user_id
                    )
                    self._send_message_to_scheduler(
                        user_id=chat_req.user_id,
                        mem_cube_id=scheduler_cube_id,
                        query=chat_req.query,
                        label=QUERY_TASK_LABEL,
                    )
                    # Extract memories from search results
                    memories_list = []
                    if search_response.data and search_response.data.get("text_mem"):
                        text_mem_results = search_response.data["text_mem"]
                        if text_mem_results and text_mem_results[0].get("memories"):
                            memories_list = text_mem_results[0]["memories"]

                    # Filter memories by threshold
                    filtered_memories = self._filter_memories_by_threshold(memories_list)

                    # Step 2: Build system prompt with memories
                    system_prompt = self._build_system_prompt(
                        query=chat_req.query,
                        memories=filtered_memories,
                        pref_string=search_response.data.get("pref_string", ""),
                        base_prompt=chat_req.system_prompt,
                    )

                    # Prepare messages
                    history_info = chat_req.history[-20:] if chat_req.history else []
                    current_messages = [
                        {"role": "system", "content": system_prompt},
                        *history_info,
                        {"role": "user", "content": chat_req.query},
                    ]

                    self.logger.info(
                        f"user_id: {chat_req.user_id}, readable_cube_ids: {readable_cube_ids}, "
                        f"current_system_prompt: {system_prompt}"
                    )

                    # Step 3: Generate streaming response from LLM
                    if (
                        chat_req.model_name_or_path
                        and chat_req.model_name_or_path not in self.chat_llms
                    ):
                        raise HTTPException(
                            status_code=400,
                            detail=f"Model {chat_req.model_name_or_path} not suport, choose from {list(self.chat_llms.keys())}",
                        )

                    model = chat_req.model_name_or_path or next(iter(self.chat_llms.keys()))
                    self.logger.info(f"[Cloud Service Chat Stream Model]: {model}")

                    start = time.time()
                    response_stream = self.chat_llms[model].generate_stream(
                        current_messages, model_name_or_path=model
                    )
                    end = time.time()
                    self.logger.info(f"[Cloud Service Chat Stream Time]: {end - start} seconds")

                    # Stream the response
                    buffer = ""
                    full_response = ""
                    in_think = False

                    for chunk in response_stream:
                        if chunk == "<think>":
                            in_think = True
                            continue
                        if chunk == "</think>":
                            in_think = False
                            continue

                        if in_think:
                            chunk_data = f"data: {json.dumps({'type': 'reasoning', 'data': chunk}, ensure_ascii=False)}\n\n"
                            yield chunk_data
                            continue

                        buffer += chunk
                        full_response += chunk

                        chunk_data = f"data: {json.dumps({'type': 'text', 'data': chunk}, ensure_ascii=False)}\n\n"
                        yield chunk_data

                    current_messages.append({"role": "assistant", "content": full_response})
                    if chat_req.add_message_on_answer:
                        # Resolve writable cube IDs (for add)
                        writable_cube_ids = chat_req.writable_cube_ids or (
                            [chat_req.mem_cube_id] if chat_req.mem_cube_id else [chat_req.user_id]
                        )
                        start = time.time()
                        self._start_add_to_memory(
                            user_id=chat_req.user_id,
                            writable_cube_ids=writable_cube_ids,
                            session_id=chat_req.session_id or "default_session",
                            query=chat_req.query,
                            full_response=full_response,
                            async_mode="async",
                        )
                        end = time.time()
                        self.logger.info(
                            f"[Cloud Service Chat Stream Add Time]: {end - start} seconds"
                        )
                except Exception as e:
                    self.logger.error(f"Error in chat stream: {e}", exc_info=True)
                    error_data = f"data: {json.dumps({'type': 'error', 'content': str(traceback.format_exc())})}\n\n"
                    yield error_data

            return StreamingResponse(
                generate_chat_response(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Content-Type": "text/event-stream",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Methods": "*",
                },
            )

        except ValueError as err:
            raise HTTPException(status_code=404, detail=str(traceback.format_exc())) from err
        except Exception as err:
            self.logger.error(f"Failed to start chat stream: {traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=str(traceback.format_exc())) from err

    def handle_chat_stream_playground(self, chat_req: ChatPlaygroundRequest) -> StreamingResponse:
        """
        Chat with MemOS via Server-Sent Events (SSE) stream using search/add handlers.

        This implementation directly uses search_handler and add_handler.

        Args:
            chat_req: Chat stream request

        Returns:
            StreamingResponse with SSE formatted chat stream

        Raises:
            HTTPException: If stream initialization fails
        """
        try:

            def generate_chat_response() -> Generator[str, None, None]:
                """Generate chat response as SSE stream."""
                try:
                    import time

                    time_start = time.time()

                    # Step 1: Search for memories using search handler
                    yield f"data: {json.dumps({'type': 'status', 'data': '0'})}\n\n"

                    # Resolve readable cube IDs (for search)
                    readable_cube_ids = chat_req.readable_cube_ids or (
                        [chat_req.mem_cube_id] if chat_req.mem_cube_id else [chat_req.user_id]
                    )
                    # Resolve writable cube IDs (for add)
                    writable_cube_ids = chat_req.writable_cube_ids or (
                        [chat_req.mem_cube_id] if chat_req.mem_cube_id else [chat_req.user_id]
                    )

                    # ====== first search text mem with parse goal ======
                    search_req = APISearchRequest(
                        query=chat_req.query,
                        user_id=chat_req.user_id,
                        readable_cube_ids=readable_cube_ids,
                        mode="fast",
                        internet_search=False,
                        top_k=20,
                        chat_history=chat_req.history,
                        session_id=chat_req.session_id,
                        include_preference=True,
                        pref_top_k=chat_req.pref_top_k,
                        filter=chat_req.filter,
                        search_tool_memory=False,
                    )
                    start_time = time.time()
                    search_response = self.search_handler.handle_search_memories(search_req)
                    end_time = time.time()
                    self.logger.info(f"first search time: {end_time - start_time}")

                    yield f"data: {json.dumps({'type': 'status', 'data': '1'})}\n\n"

                    # Extract memories from search results (first search)
                    memories_list = []
                    if search_response.data and search_response.data.get("text_mem"):
                        text_mem_results = search_response.data["text_mem"]
                        if text_mem_results and text_mem_results[0].get("memories"):
                            memories_list = text_mem_results[0]["memories"]

                    # Filter memories by threshold
                    filtered_memories = self._filter_memories_by_threshold(memories_list)[:5]

                    # Prepare reference data (first search)
                    reference = prepare_reference_data(filtered_memories)
                    # get preference string
                    pref_string = search_response.data.get("pref_string", "")

                    yield f"data: {json.dumps({'type': 'reference', 'data': reference})}\n\n"

                    # Prepare preference markdown string
                    if chat_req.include_preference:
                        pref_list = search_response.data.get("pref_mem") or []
                        pref_memories = pref_list[0].get("memories", []) if pref_list else []
                        pref_md_string = self._build_pref_md_string_for_playground(pref_memories)
                        yield f"data: {json.dumps({'type': 'pref_md_string', 'data': pref_md_string}, ensure_ascii=False)}\n\n"

                    # Use first readable cube ID for scheduler (backward compatibility)
                    scheduler_cube_id = (
                        readable_cube_ids[0] if readable_cube_ids else chat_req.user_id
                    )
                    self._send_message_to_scheduler(
                        user_id=chat_req.user_id,
                        mem_cube_id=scheduler_cube_id,
                        query=chat_req.query,
                        label=QUERY_TASK_LABEL,
                    )

                    # parse goal for internet search
                    searcher = self.dependencies.searcher
                    parsed_goal = searcher.task_goal_parser.parse(
                        task_description=chat_req.query,
                        context="\n".join([memory.get("memory", "") for memory in memories_list]),
                        conversation=chat_req.history,
                        mode="fine",
                    )
                    self.logger.info(f"[PLAYGROUND chat parsed_goal]: {parsed_goal}")

                    if chat_req.beginner_guide_step == "first":
                        chat_req.internet_search = False
                        parsed_goal.internet_search = False
                    elif chat_req.beginner_guide_step == "second":
                        chat_req.internet_search = True
                        parsed_goal.internet_search = True

                    if chat_req.internet_search or parsed_goal.internet_search:
                        # internet status
                        yield f"data: {json.dumps({'type': 'status', 'data': 'start_internet_search'})}\n\n"

                    # ======  second deep search  ======
                    search_req = APISearchRequest(
                        query=(parsed_goal.rephrased_query or chat_req.query)
                        + (f" {parsed_goal.memories}" if parsed_goal.memories else ""),
                        user_id=chat_req.user_id,
                        readable_cube_ids=readable_cube_ids,
                        mode="fast",
                        internet_search=chat_req.internet_search or parsed_goal.internet_search,
                        top_k=100,  # for playground, we need to search more memories
                        chat_history=chat_req.history,
                        session_id=chat_req.session_id,
                        include_preference=False,
                        pref_top_k=chat_req.pref_top_k,
                        filter=chat_req.filter,
                        search_memory_type="All",
                        search_tool_memory=False,
                    )

                    self.logger.info(f"[PLAYGROUND second search query]: {search_req.query}")

                    start_time = time.time()
                    search_response = self.search_handler.handle_search_memories(search_req)
                    end_time = time.time()
                    self.logger.info(f"second search time: {end_time - start_time}")

                    # for playground, add the query to memory without response
                    self._start_add_to_memory(
                        user_id=chat_req.user_id,
                        writable_cube_ids=writable_cube_ids,
                        session_id=chat_req.session_id or "default_session",
                        query=chat_req.query,
                        full_response=None,
                        async_mode="sync",
                    )

                    # Extract memories from search results (second search)
                    memories_list = []
                    if search_response.data and search_response.data.get("text_mem"):
                        text_mem_results = search_response.data["text_mem"]
                        if text_mem_results and text_mem_results[0].get("memories"):
                            memories_list = text_mem_results[0]["memories"]

                    # Filter memories by threshold, min_num is the min number of memories for playground
                    second_filtered_memories = self._filter_memories_by_threshold(
                        memories_list, min_num=35
                    )

                    # dedup and supplement memories
                    fast_length = len(filtered_memories)
                    supplement_length = max(0, 50 - fast_length)  # 50 is the max mem for playground
                    second_dedup_memories = self._dedup_and_supplement_memories(
                        filtered_memories, second_filtered_memories
                    )[:supplement_length]
                    filtered_memories = filtered_memories + second_dedup_memories

                    # Prepare remain reference data (second search)
                    reference = prepare_reference_data(filtered_memories)
                    # get internet reference
                    internet_reference = self._get_internet_reference(
                        search_response.data.get("text_mem")[0]["memories"]
                    )
                    yield f"data: {json.dumps({'type': 'reference', 'data': reference})}\n\n"

                    # Step 2: Build system prompt with memories
                    lang = detect_lang(chat_req.query)
                    if pref_string:
                        pref_string += (
                            "\n# 注意\n- 在思考内容中，不要出现引用序号和id [1,2,3]等标记，否则会导致引用错误。"
                            if lang == "zh"
                            else "\n#warning\n- In thinking content, do not appear the reference number and id [1,2,3]etc. otherwise it will cause reference error."
                        )
                    system_prompt = self._build_enhance_system_prompt(
                        filtered_memories, pref_string, lang=lang
                    )

                    # Prepare messages
                    history_info = chat_req.history[-20:] if chat_req.history else []
                    current_messages = [
                        {"role": "system", "content": system_prompt},
                        *history_info,
                        {"role": "user", "content": chat_req.query},
                    ]

                    self.logger.info(
                        f"user_id: {chat_req.user_id}, readable_cube_ids: {readable_cube_ids}, "
                        f"current_system_prompt: {system_prompt}"
                    )

                    # Step 3: Generate streaming response from LLM
                    try:
                        model = next(iter(self.chat_llms.keys()))
                        response_stream = self.chat_llms[model].generate_stream(
                            current_messages, model_name_or_path=model
                        )

                        # Stream the response
                        buffer = ""
                        full_response = ""
                        in_think = False

                        for chunk in response_stream:
                            if chunk == "<think>":
                                in_think = True
                                yield f"data: {json.dumps({'type': 'status', 'data': 'reasoning'})}\n\n"
                                continue
                            if chunk == "</think>":
                                in_think = False
                                yield f"data: {json.dumps({'type': 'status', 'data': '2'})}\n\n"
                                continue

                            if in_think:
                                chunk_data = f"data: {json.dumps({'type': 'reasoning', 'data': chunk}, ensure_ascii=False)}\n\n"
                                yield chunk_data
                                continue

                            buffer += chunk
                            full_response += chunk

                            # Process buffer to ensure complete reference tags
                            processed_chunk, remaining_buffer = (
                                process_streaming_references_complete(buffer)
                            )

                            if processed_chunk:
                                chunk_data = f"data: {json.dumps({'type': 'text', 'data': processed_chunk}, ensure_ascii=False)}\n\n"
                                yield chunk_data
                                buffer = remaining_buffer

                        # Process any remaining buffer
                        if buffer:
                            processed_chunk, _ = process_streaming_references_complete(buffer)
                            if processed_chunk:
                                chunk_data = f"data: {json.dumps({'type': 'text', 'data': processed_chunk}, ensure_ascii=False)}\n\n"
                                yield chunk_data

                    except Exception as llm_error:
                        # Log the error
                        self.logger.error(
                            f"Error during LLM generation: {llm_error}", exc_info=True
                        )
                        # Send error message to client
                        error_msg = f"模型生成错误: {llm_error!s}"
                        yield f"data: {json.dumps({'type': 'error', 'data': error_msg}, ensure_ascii=False)}\n\n"
                        # Re-raise to let outer exception handler process it
                        raise

                    if chat_req.internet_search or parsed_goal.internet_search:
                        # Yield internet reference after text response
                        yield f"data: {json.dumps({'type': 'internet_reference', 'data': internet_reference})}\n\n"

                    # Calculate timing
                    time_end = time.time()
                    speed_improvement = round(float((len(system_prompt) / 2) * 0.0048 + 44.5), 1)
                    total_time = round(float(time_end - time_start), 1)

                    yield f"data: {json.dumps({'type': 'time', 'data': {'total_time': total_time, 'speed_improvement': f'{speed_improvement}%'}})}\n\n"

                    # Get further suggestion
                    current_messages.append({"role": "assistant", "content": full_response})
                    further_suggestion = self._get_further_suggestion(current_messages)
                    self.logger.info(f"further_suggestion: {further_suggestion}")
                    yield f"data: {json.dumps({'type': 'suggestion', 'data': further_suggestion})}\n\n"

                    yield f"data: {json.dumps({'type': 'end'})}\n\n"

                    # Use first readable cube ID for post-processing (backward compatibility)
                    scheduler_cube_id = (
                        readable_cube_ids[0] if readable_cube_ids else chat_req.user_id
                    )
                    self._start_post_chat_processing(
                        user_id=chat_req.user_id,
                        cube_id=scheduler_cube_id,
                        session_id=chat_req.session_id or "default_session",
                        query=chat_req.query,
                        full_response=full_response,
                        system_prompt=system_prompt,
                        time_start=time_start,
                        time_end=time_end,
                        speed_improvement=speed_improvement,
                        current_messages=current_messages,
                    )
                    self._start_add_to_memory(
                        user_id=chat_req.user_id,
                        writable_cube_ids=writable_cube_ids,
                        session_id=chat_req.session_id or "default_session",
                        query=chat_req.query,
                        full_response=full_response,
                        async_mode="sync",
                    )

                except Exception as e:
                    self.logger.error(f"Error in chat stream: {e}", exc_info=True)
                    error_data = f"data: {json.dumps({'type': 'error', 'content': str(traceback.format_exc())})}\n\n"
                    yield error_data

            return StreamingResponse(
                generate_chat_response(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Content-Type": "text/event-stream",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Methods": "*",
                },
            )

        except ValueError as err:
            raise HTTPException(status_code=404, detail=str(traceback.format_exc())) from err
        except Exception as err:
            self.logger.error(f"Failed to start chat stream: {traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=str(traceback.format_exc())) from err

    def _dedup_and_supplement_memories(
        self, first_filtered_memories: list, second_filtered_memories: list
    ) -> list:
        """
        Remove memories from second_filtered_memories whose content already exists in
        first_filtered_memories, return the remaining list.
        """

        def _norm(text: str) -> str:
            # Use normalized text as the dedup key; keep original text in the payload.
            return " ".join(text.split())

        first_memory_texts = {_norm(memory.get("memory", "")) for memory in first_filtered_memories}

        remaining_memories = []
        for memory in second_filtered_memories:
            key = _norm(memory.get("memory", ""))
            if key in first_memory_texts:
                continue
            first_memory_texts.add(key)
            remaining_memories.append(memory)
        return remaining_memories

    def _get_internet_reference(
        self, search_response: list[dict[str, any]]
    ) -> list[dict[str, any]]:
        """Get internet reference from search response."""
        unique_set = set()
        result = []

        for item in search_response:
            meta = item.get("metadata", {})
            if meta.get("source") == "web" and meta.get("internet_info"):
                info = meta.get("internet_info")
                key = json.dumps(info, sort_keys=True)
                if key not in unique_set:
                    unique_set.add(key)
                    result.append(info)
        return result

    def _build_pref_md_string_for_playground(self, pref_mem_list: list[any]) -> str:
        """Build preference markdown string for playground."""
        explicit = []
        implicit = []
        for pref_mem in pref_mem_list:
            if pref_mem["metadata"]["preference_type"] == "explicit_preference":
                explicit.append(
                    {
                        "content": pref_mem["metadata"]["preference"],
                        "reasoning": pref_mem["metadata"]["reasoning"],
                    }
                )
            elif pref_mem["metadata"]["preference_type"] == "implicit_preference":
                implicit.append(
                    {
                        "content": pref_mem["metadata"]["preference"],
                        "reasoning": pref_mem["metadata"]["reasoning"],
                    }
                )

        explicit_md = "\n\n".join(
            [
                f"显性偏好 {i + 1}:\n- 抽取内容: {pref['content']}\n- 抽取理由: {pref['reasoning']}"
                for i, pref in enumerate(explicit)
            ]
        )
        implicit_md = "\n\n".join(
            [
                f"隐性偏好 {i + 1}:\n- 抽取内容: {pref['content']}\n- 抽取理由: {pref['reasoning']}"
                for i, pref in enumerate(implicit)
            ]
        )

        return f"{explicit_md}\n\n{implicit_md}"

    def _build_system_prompt(
        self,
        query: str,
        memories: list | None = None,
        pref_string: str | None = None,
        base_prompt: str | None = None,
        **kwargs,
    ) -> str:
        """Build system prompt with optional memories context."""
        if base_prompt is None:
            lang = detect_lang(query)
            base_prompt = get_cloud_chat_prompt(lang=lang)

        memory_context = ""
        if memories:
            memory_list = []
            for i, memory in enumerate(memories, 1):
                text_memory = memory.get("memory", "")
                memory_list.append(f"{i}. {text_memory}")
            memory_context = "\n".join(memory_list)
        if pref_string:
            memory_context += f"\n\n{pref_string}"

        if "{memories}" in base_prompt:
            return base_prompt.format(memories=memory_context)
        elif base_prompt and memories:
            # For backward compatibility, append memories if no placeholder is found
            memory_context_with_header = "\n\n## Fact Memories:\n" + memory_context
            return base_prompt + memory_context_with_header
        return base_prompt

    def _build_enhance_system_prompt(
        self,
        memories_list: list,
        pref_string: str = "",
        lang: str = "en",
        tone: str = "friendly",
        verbosity: str = "mid",
    ) -> str:
        """
        Build enhanced system prompt with memories (for streaming response).

        Args:
            memories_list: List of memory items
            pref_string: Preference string
            tone: Tone of the prompt
            verbosity: Verbosity level

        Returns:
            System prompt string
        """
        now = datetime.now()
        formatted_date = now.strftime("%Y-%m-%d %H:%M (%A)")
        sys_body = get_memos_prompt(
            date=formatted_date, tone=tone, verbosity=verbosity, mode="enhance", lang=lang
        )

        # Format memories
        mem_block_o, mem_block_p = self._format_mem_block(memories_list)

        return (
            sys_body
            + "\n\n# Memories\n## PersonalMemory (ordered)\n"
            + mem_block_p
            + "\n## OuterMemory (from Internet Search, ordered)\n"
            + mem_block_o
            + f"\n\n{pref_string}"
        )

    def _format_mem_block(
        self, memories_all: list, max_items: int = 20, max_chars_each: int = 320
    ) -> tuple[str, str]:
        """
        Format memory block for prompt.

        Args:
            memories_all: List of memory items
            max_items: Maximum number of items to format
            max_chars_each: Maximum characters per item

        Returns:
            Tuple of (outer_memory_block, personal_memory_block)
        """
        if not memories_all:
            return "(none)", "(none)"

        lines_o = []
        lines_p = []

        for idx, m in enumerate(memories_all[:max_items], 1):
            mid = m.get("id", "").split("-")[0] if m.get("id") else f"mem_{idx}"
            memory_content = m.get("memory", "")
            metadata = m.get("metadata", {})
            memory_type = metadata.get("memory_type", "")
            created_time = metadata.get("updated_at", "") or metadata.get("created_at", "")

            # format time to YYYY-MM-DD HH:MM (ISO 8601 -> YYYY-MM-DD HH:MM)
            if created_time and isinstance(created_time, str):
                try:
                    dt = datetime.fromisoformat(created_time)
                    created_time = dt.strftime("%Y-%m-%d %H:%M")
                except ValueError:
                    pass  # keep original value

            tag = "O" if "Outer" in str(memory_type) else "P"
            txt = memory_content.replace("\n", " ").strip()
            if len(txt) > max_chars_each:
                txt = txt[: max_chars_each - 1] + "…"

            mid = mid or f"mem_{idx}"
            if tag == "O":
                lines_o.append(f"[{idx}:{mid}] :: [{tag}] {txt}\n")
            elif tag == "P":
                txt = f"(CreatedTime: {created_time}) {txt}"
                lines_p.append(f"[{idx}:{mid}] :: [{tag}] {txt}")

        return "\n".join(lines_o), "\n".join(lines_p)

    def _filter_memories_by_threshold(
        self,
        memories: list,
        threshold: float = 0.30,
        min_num: int = 3,
        memory_type: Literal["OuterMemory"] = "OuterMemory",
    ) -> list:
        """
        Filter memories by threshold and type.

        Args:
            memories: List of memory items
            threshold: Relevance threshold
            min_num: Minimum number of memories to keep
            memory_type: Memory type to filter

        Returns:
            Filtered list of memories
        """
        if not memories:
            return []

        # Handle dict format (from search results)
        def get_relativity(m):
            if isinstance(m, dict):
                return m.get("metadata", {}).get("relativity", 0.0)
            return getattr(getattr(m, "metadata", None), "relativity", 0.0)

        def get_memory_type(m):
            if isinstance(m, dict):
                return m.get("metadata", {}).get("memory_type", "")
            return getattr(getattr(m, "metadata", None), "memory_type", "")

        sorted_memories = sorted(memories, key=get_relativity, reverse=True)
        filtered_person = [m for m in memories if get_memory_type(m) != memory_type]
        filtered_outer = [m for m in memories if get_memory_type(m) == memory_type]

        filtered = []
        per_memory_count = 0

        for m in sorted_memories:
            if get_relativity(m) >= threshold:
                if get_memory_type(m) != memory_type:
                    per_memory_count += 1
                filtered.append(m)

        if len(filtered) < min_num:
            filtered = filtered_person[:min_num] + filtered_outer[:min_num]
        else:
            if per_memory_count < min_num:
                filtered += filtered_person[per_memory_count:min_num]

        filtered_memory = sorted(filtered, key=get_relativity, reverse=True)
        return filtered_memory

    def _get_further_suggestion(
        self,
        current_messages: MessageList,
    ) -> list[str]:
        """Get further suggestion based on current messages."""
        try:
            dialogue_info = "\n".join(
                [f"{msg['role']}: {msg['content']}" for msg in current_messages[-2:]]
            )
            further_suggestion_prompt = FURTHER_SUGGESTION_PROMPT.format(dialogue=dialogue_info)
            message_list = [{"role": "system", "content": further_suggestion_prompt}]
            response = self.llm.generate(message_list)
            clean_response = clean_json_response(response)
            response_json = json.loads(clean_response)
            return response_json["query"]
        except Exception as e:
            self.logger.error(f"Error getting further suggestion: {e}", exc_info=True)
            return []

    def _extract_references_from_response(self, response: str) -> tuple[str, list[dict]]:
        """Extract reference information from the response and return clean text."""
        import re

        try:
            references = []
            # Pattern to match [refid:memoriesID]
            pattern = r"\[(\d+):([^\]]+)\]"

            matches = re.findall(pattern, response)
            for ref_number, memory_id in matches:
                references.append({"memory_id": memory_id, "reference_number": int(ref_number)})

            # Remove all reference markers from the text to get clean text
            clean_text = re.sub(pattern, "", response)

            # Clean up any extra whitespace that might be left after removing markers
            clean_text = re.sub(r"\s+", " ", clean_text).strip()

            return clean_text, references
        except Exception as e:
            self.logger.error(f"Error extracting references from response: {e}", exc_info=True)
            return response, []

    def _extract_struct_data_from_history(self, chat_data: list[dict]) -> dict:
        """
        Extract structured message data from chat history.

        Args:
            chat_data: List of chat messages

        Returns:
            Dictionary with system, memory, and chat_history
        """
        system_content = ""
        memory_content = ""
        chat_history = []

        for item in chat_data:
            role = item.get("role")
            content = item.get("content", "")
            if role == "system":
                parts = content.split("# Memories", 1)
                system_content = parts[0].strip()
                if len(parts) > 1:
                    memory_content = "# Memories" + parts[1].strip()
            elif role in ("user", "assistant"):
                chat_history.append({"role": role, "content": content})

        if chat_history and chat_history[-1]["role"] == "assistant":
            if len(chat_history) >= 2 and chat_history[-2]["role"] == "user":
                chat_history = chat_history[:-2]
            else:
                chat_history = chat_history[:-1]

        return {"system": system_content, "memory": memory_content, "chat_history": chat_history}

    def _send_message_to_scheduler(
        self,
        user_id: str,
        mem_cube_id: str,
        query: str,
        label: str,
    ) -> None:
        """
        Send message to scheduler.

        Args:
            user_id: User ID
            mem_cube_id: Memory cube ID
            query: Query content
            label: Message label
        """
        try:
            message_item = ScheduleMessageItem(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                label=label,
                content=query,
                timestamp=datetime.utcnow(),
            )
            self.mem_scheduler.submit_messages(messages=[message_item])
            self.logger.info(f"Sent message to scheduler with label: {label}")
        except Exception as e:
            self.logger.error(f"Failed to send message to scheduler: {e}", exc_info=True)

    async def _add_conversation_to_memory(
        self,
        user_id: str,
        writable_cube_ids: list[str],
        session_id: str,
        query: str,
        clean_response: str | None = None,
        async_mode: Literal["async", "sync"] = "sync",
    ) -> None:
        messages = [
            {
                "role": "user",
                "content": query,
                "chat_time": str(datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            }
        ]
        if clean_response:
            messages.append(
                {
                    "role": "assistant",
                    "content": clean_response,
                    "chat_time": str(datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                }
            )
        add_req = APIADDRequest(
            user_id=user_id,
            writable_cube_ids=writable_cube_ids,
            session_id=session_id,
            messages=messages,
            async_mode=async_mode,
        )

        self.add_handler.handle_add_memories(add_req)

    async def _post_chat_processing(
        self,
        user_id: str,
        cube_id: str,
        session_id: str,
        query: str,
        full_response: str,
        system_prompt: str,
        time_start: float,
        time_end: float,
        speed_improvement: float,
        current_messages: list,
    ) -> None:
        """
        Asynchronous post-chat processing with complete functionality.

        Includes:
        - Reference extraction
        - DingDing notification
        - Scheduler messaging
        - Memory addition

        Args:
            user_id: User ID
            cube_id: Memory cube ID
            session_id: Session ID
            query: User query
            full_response: Full LLM response
            system_prompt: System prompt used
            time_start: Start timestamp
            time_end: End timestamp
            speed_improvement: Speed improvement metric
            current_messages: Current message history
        """
        try:
            self.logger.info(
                f"user_id: {user_id}, cube_id: {cube_id}, current_messages: {current_messages}"
            )
            self.logger.info(
                f"user_id: {user_id}, cube_id: {cube_id}, full_response: {full_response}"
            )

            # Extract references and clean response
            clean_response, extracted_references = self._extract_references_from_response(
                full_response
            )
            struct_message = self._extract_struct_data_from_history(current_messages)
            self.logger.info(f"Extracted {len(extracted_references)} references from response")

            # Send DingDing notification if enabled
            if self.online_bot:
                self.logger.info("Online Bot Open!")
                try:
                    from memos.memos_tools.notification_utils import (
                        send_online_bot_notification_async,
                    )

                    # Prepare notification data
                    chat_data = {"query": query, "user_id": user_id, "cube_id": cube_id}
                    chat_data.update(
                        {
                            "memory": struct_message["memory"],
                            "chat_history": struct_message["chat_history"],
                            "full_response": full_response,
                        }
                    )

                    system_data = {
                        "references": extracted_references,
                        "time_start": time_start,
                        "time_end": time_end,
                        "speed_improvement": speed_improvement,
                    }

                    emoji_config = {"chat": "💬", "system_info": "📊"}

                    await send_online_bot_notification_async(
                        online_bot=self.online_bot,
                        header_name="MemOS Chat Report",
                        sub_title_name="chat_with_references",
                        title_color="#00956D",
                        other_data1=chat_data,
                        other_data2=system_data,
                        emoji=emoji_config,
                    )
                except Exception as e:
                    self.logger.warning(f"Failed to send chat notification (async): {e}")

            # Send answer to scheduler
            self._send_message_to_scheduler(
                user_id=user_id, mem_cube_id=cube_id, query=clean_response, label=ANSWER_TASK_LABEL
            )

            self.logger.info(f"Post-chat processing completed for user {user_id}")

        except Exception as e:
            self.logger.error(
                f"Error in post-chat processing for user {user_id}: {e}", exc_info=True
            )

    def _start_post_chat_processing(
        self,
        user_id: str,
        cube_id: str,
        session_id: str,
        query: str,
        full_response: str,
        system_prompt: str,
        time_start: float,
        time_end: float,
        speed_improvement: float,
        current_messages: list,
    ) -> None:
        """
        Start asynchronous post-chat processing in a background thread.

        Args:
            user_id: User ID
            cube_id: Memory cube ID
            session_id: Session ID
            query: User query
            full_response: Full LLM response
            system_prompt: System prompt used
            time_start: Start timestamp
            time_end: End timestamp
            speed_improvement: Speed improvement metric
            current_messages: Current message history
        """

        def run_async_in_thread():
            """Running asynchronous tasks in a new thread"""
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(
                        self._post_chat_processing(
                            user_id=user_id,
                            cube_id=cube_id,
                            session_id=session_id,
                            query=query,
                            full_response=full_response,
                            system_prompt=system_prompt,
                            time_start=time_start,
                            time_end=time_end,
                            speed_improvement=speed_improvement,
                            current_messages=current_messages,
                        )
                    )
                finally:
                    loop.close()
            except Exception as e:
                self.logger.error(
                    f"Error in thread-based post-chat processing for user {user_id}: {e}",
                    exc_info=True,
                )

        try:
            # Try to get the current event loop
            asyncio.get_running_loop()
            # Create task and store reference to prevent garbage collection
            task = asyncio.create_task(
                self._post_chat_processing(
                    user_id=user_id,
                    cube_id=cube_id,
                    session_id=session_id,
                    query=query,
                    full_response=full_response,
                    system_prompt=system_prompt,
                    time_start=time_start,
                    time_end=time_end,
                    speed_improvement=speed_improvement,
                    current_messages=current_messages,
                )
            )
            # Add exception handling for the background task
            task.add_done_callback(
                lambda t: self.logger.error(
                    f"Error in background post-chat processing for user {user_id}: {t.exception()}",
                    exc_info=True,
                )
                if t.exception()
                else None
            )
        except RuntimeError:
            # No event loop, run in a new thread with context propagation
            thread = ContextThread(
                target=run_async_in_thread,
                name=f"PostChatProcessing-{user_id}",
                daemon=True,
            )
            thread.start()

    def _start_add_to_memory(
        self,
        user_id: str,
        writable_cube_ids: list[str],
        session_id: str,
        query: str,
        full_response: str | None = None,
        async_mode: Literal["async", "sync"] = "sync",
    ) -> None:
        def run_async_in_thread():
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    clean_response = full_response
                    if full_response:
                        clean_response, _ = self._extract_references_from_response(full_response)
                    loop.run_until_complete(
                        self._add_conversation_to_memory(
                            user_id=user_id,
                            writable_cube_ids=writable_cube_ids,
                            session_id=session_id,
                            query=query,
                            clean_response=clean_response,
                            async_mode=async_mode,
                        )
                    )
                finally:
                    loop.close()
            except Exception as e:
                self.logger.error(
                    f"Error in thread-based add to memory for user {user_id}: {e}",
                    exc_info=True,
                )

        try:
            asyncio.get_running_loop()
            clean_response = full_response
            if full_response:
                clean_response, _ = self._extract_references_from_response(full_response)
            task = asyncio.create_task(
                self._add_conversation_to_memory(
                    user_id=user_id,
                    writable_cube_ids=writable_cube_ids,
                    session_id=session_id,
                    query=query,
                    clean_response=clean_response,
                    async_mode=async_mode,
                )
            )
            task.add_done_callback(
                lambda t: self.logger.error(
                    f"Error in background add to memory for user {user_id}: {t.exception()}",
                    exc_info=True,
                )
                if t.exception()
                else None
            )
        except RuntimeError:
            thread = ContextThread(
                target=run_async_in_thread,
                name=f"AddToMemory-{user_id}",
                daemon=True,
            )
            thread.start()
