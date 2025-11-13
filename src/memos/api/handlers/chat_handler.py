"""
Chat handler for chat functionality (Class-based version).

This module provides a complete implementation of chat handlers,
consolidating all chat-related logic without depending on mos_server.
"""

import asyncio
import json
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
    ChatRequest,
)
from memos.context.context import ContextThread
from memos.mem_os.utils.format_utils import clean_json_response
from memos.mem_os.utils.reference_utils import (
    prepare_reference_data,
    process_streaming_references_complete,
)
from memos.mem_scheduler.schemas.general_schemas import (
    ANSWER_LABEL,
    QUERY_LABEL,
    SearchMode,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
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
        search_handler=None,
        add_handler=None,
        online_bot=None,
    ):
        """
        Initialize chat handler.

        Args:
            dependencies: HandlerDependencies instance
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

        self.search_handler = search_handler
        self.add_handler = add_handler
        self.online_bot = online_bot

        # Check if scheduler is enabled
        self.enable_mem_scheduler = (
            hasattr(dependencies, "enable_mem_scheduler") and dependencies.enable_mem_scheduler
        )

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
            import time

            time_start = time.time()

            # Step 1: Search for relevant memories
            search_req = APISearchRequest(
                user_id=chat_req.user_id,
                mem_cube_id=chat_req.mem_cube_id,
                query=chat_req.query,
                top_k=chat_req.top_k or 10,
                session_id=chat_req.session_id,
                mode=SearchMode.FINE,
                internet_search=chat_req.internet_search,
                moscube=chat_req.moscube,
                chat_history=chat_req.history,
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
            system_prompt = self._build_system_prompt(filtered_memories, chat_req.base_prompt)

            # Prepare message history
            history_info = chat_req.history[-20:] if chat_req.history else []
            current_messages = [
                {"role": "system", "content": system_prompt},
                *history_info,
                {"role": "user", "content": chat_req.query},
            ]

            self.logger.info("Starting to generate complete response...")

            # Step 3: Generate complete response from LLM
            response = self.llm.generate(current_messages)

            time_end = time.time()

            # Step 4: Start post-chat processing asynchronously
            self._start_post_chat_processing(
                user_id=chat_req.user_id,
                cube_id=chat_req.mem_cube_id,
                session_id=chat_req.session_id or "default_session",
                query=chat_req.query,
                full_response=response,
                system_prompt=system_prompt,
                time_start=time_start,
                time_end=time_end,
                speed_improvement=0.0,
                current_messages=current_messages,
            )

            # Return the complete response
            return {
                "message": "Chat completed successfully",
                "data": {"response": response, "references": filtered_memories},
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
                    import time

                    time_start = time.time()

                    # Step 1: Search for memories using search handler
                    yield f"data: {json.dumps({'type': 'status', 'data': '0'})}\n\n"

                    search_req = APISearchRequest(
                        user_id=chat_req.user_id,
                        mem_cube_id=chat_req.mem_cube_id,
                        query=chat_req.query,
                        top_k=20,
                        session_id=chat_req.session_id,
                        mode=SearchMode.FINE,
                        internet_search=chat_req.internet_search,
                        moscube=chat_req.moscube,
                        chat_history=chat_req.history,
                    )

                    search_response = self.search_handler.handle_search_memories(search_req)

                    yield f"data: {json.dumps({'type': 'status', 'data': '1'})}\n\n"
                    self._send_message_to_scheduler(
                        user_id=chat_req.user_id,
                        mem_cube_id=chat_req.mem_cube_id,
                        query=chat_req.query,
                        label=QUERY_LABEL,
                    )
                    # Extract memories from search results
                    memories_list = []
                    if search_response.data and search_response.data.get("text_mem"):
                        text_mem_results = search_response.data["text_mem"]
                        if text_mem_results and text_mem_results[0].get("memories"):
                            memories_list = text_mem_results[0]["memories"]

                    # Filter memories by threshold
                    filtered_memories = self._filter_memories_by_threshold(memories_list)

                    # Prepare reference data
                    reference = prepare_reference_data(filtered_memories)
                    yield f"data: {json.dumps({'type': 'reference', 'data': reference})}\n\n"

                    # Step 2: Build system prompt with memories
                    system_prompt = self._build_enhance_system_prompt(filtered_memories)

                    # Prepare messages
                    history_info = chat_req.history[-20:] if chat_req.history else []
                    current_messages = [
                        {"role": "system", "content": system_prompt},
                        *history_info,
                        {"role": "user", "content": chat_req.query},
                    ]

                    self.logger.info(
                        f"user_id: {chat_req.user_id}, cube_id: {chat_req.mem_cube_id}, "
                        f"current_system_prompt: {system_prompt}"
                    )

                    yield f"data: {json.dumps({'type': 'status', 'data': '2'})}\n\n"

                    # Step 3: Generate streaming response from LLM
                    response_stream = self.llm.generate_stream(current_messages)

                    # Stream the response
                    buffer = ""
                    full_response = ""

                    for chunk in response_stream:
                        if chunk in ["<think>", "</think>"]:
                            continue

                        buffer += chunk
                        full_response += chunk

                        # Process buffer to ensure complete reference tags
                        processed_chunk, remaining_buffer = process_streaming_references_complete(
                            buffer
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

                    # Step 4: Add conversation to memory asynchronously
                    self._start_post_chat_processing(
                        user_id=chat_req.user_id,
                        cube_id=chat_req.mem_cube_id,
                        session_id=chat_req.session_id or "default_session",
                        query=chat_req.query,
                        full_response=full_response,
                        system_prompt=system_prompt,
                        time_start=time_start,
                        time_end=time_end,
                        speed_improvement=speed_improvement,
                        current_messages=current_messages,
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

    def _build_system_prompt(
        self,
        memories: list | None = None,
        base_prompt: str | None = None,
        **kwargs,
    ) -> str:
        """Build system prompt with optional memories context."""
        if base_prompt is None:
            base_prompt = (
                "You are a knowledgeable and helpful AI assistant. "
                "You have access to conversation memories that help you provide more personalized responses. "
                "Use the memories to understand the user's context, preferences, and past interactions. "
                "If memories are provided, reference them naturally when relevant, but don't explicitly mention having memories."
            )

        memory_context = ""
        if memories:
            memory_list = []
            for i, memory in enumerate(memories, 1):
                    text_memory = memory.get("memory", "")
                    memory_list.append(f"{i}. {text_memory}")
            memory_context = "\n".join(memory_list)

        if "{memories}" in base_prompt:
            return base_prompt.format(memories=memory_context)
        elif base_prompt and memories:
            # For backward compatibility, append memories if no placeholder is found
            memory_context_with_header = "\n\n## Memories:\n" + memory_context
            return base_prompt + memory_context_with_header
        return base_prompt

    def _build_enhance_system_prompt(
        self,
        memories_list: list,
        tone: str = "friendly",
        verbosity: str = "mid",
    ) -> str:
        """
        Build enhanced system prompt with memories (for streaming response).

        Args:
            memories_list: List of memory items
            tone: Tone of the prompt
            verbosity: Verbosity level

        Returns:
            System prompt string
        """
        now = datetime.now()
        formatted_date = now.strftime("%Y-%m-%d (%A)")
        sys_body = get_memos_prompt(
            date=formatted_date, tone=tone, verbosity=verbosity, mode="enhance"
        )

        # Format memories
        mem_block_o, mem_block_p = self._format_mem_block(memories_list)

        return (
            sys_body
            + "\n\n# Memories\n## PersonalMemory (ordered)\n"
            + mem_block_p
            + "\n## OuterMemory (ordered)\n"
            + mem_block_o
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

            tag = "O" if "Outer" in str(memory_type) else "P"
            txt = memory_content.replace("\n", " ").strip()
            if len(txt) > max_chars_each:
                txt = txt[: max_chars_each - 1] + "…"

            mid = mid or f"mem_{idx}"
            if tag == "O":
                lines_o.append(f"[{idx}:{mid}] :: [{tag}] {txt}\n")
            elif tag == "P":
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
                user_id=user_id, mem_cube_id=cube_id, query=clean_response, label=ANSWER_LABEL
            )

            # Add conversation to memory using add handler
            add_req = APIADDRequest(
                user_id=user_id,
                mem_cube_id=cube_id,
                session_id=session_id,
                messages=[
                    {
                        "role": "user",
                        "content": query,
                        "chat_time": str(datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                    },
                    {
                        "role": "assistant",
                        "content": clean_response,  # Store clean text without reference markers
                        "chat_time": str(datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                    },
                ],
                async_mode="sync",  # set suync for playground
            )

            self.add_handler.handle_add_memories(add_req)

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
