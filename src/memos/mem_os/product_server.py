import asyncio
import time

from datetime import datetime
from typing import Literal

from memos.context.context import ContextThread
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.navie import NaiveMemCube
from memos.mem_os.product import _format_mem_block
from memos.mem_reader.base import BaseMemReader
from memos.memories.textual.item import TextualMemoryItem
from memos.templates.mos_prompts import (
    get_memos_prompt,
)
from memos.types import MessageList


logger = get_logger(__name__)


class MOSServer:
    def __init__(
        self,
        mem_reader: BaseMemReader | None = None,
        llm: BaseLLM | None = None,
        online_bot: bool = False,
    ):
        self.mem_reader = mem_reader
        self.chat_llm = llm
        self.online_bot = online_bot

    def chat(
        self,
        query: str,
        user_id: str,
        cube_id: str | None = None,
        mem_cube: NaiveMemCube | None = None,
        history: MessageList | None = None,
        base_prompt: str | None = None,
        internet_search: bool = False,
        moscube: bool = False,
        top_k: int = 10,
        threshold: float = 0.5,
        session_id: str | None = None,
    ) -> str:
        """
        Chat with LLM with memory references and complete response.
        """
        time_start = time.time()
        memories_result = mem_cube.text_mem.search(
            query=query,
            user_name=cube_id,
            top_k=top_k,
            mode="fine",
            manual_close_internet=not internet_search,
            moscube=moscube,
            info={
                "user_id": user_id,
                "session_id": session_id,
                "chat_history": history,
            },
        )

        memories_list = []
        if memories_result:
            memories_list = self._filter_memories_by_threshold(memories_result, threshold)
            new_memories_list = []
            for m in memories_list:
                m.metadata.embedding = []
                new_memories_list.append(m)
            memories_list = new_memories_list
        system_prompt = self._build_system_prompt(memories_list, base_prompt)

        history_info = []
        if history:
            history_info = history[-20:]
        current_messages = [
            {"role": "system", "content": system_prompt},
            *history_info,
            {"role": "user", "content": query},
        ]
        response = self.chat_llm.generate(current_messages)
        time_end = time.time()
        self._start_post_chat_processing(
            user_id=user_id,
            cube_id=cube_id,
            session_id=session_id,
            query=query,
            full_response=response,
            system_prompt=system_prompt,
            time_start=time_start,
            time_end=time_end,
            speed_improvement=0.0,
            current_messages=current_messages,
            mem_cube=mem_cube,
            history=history,
        )
        return response, memories_list

    def add(
        self,
        user_id: str,
        cube_id: str,
        mem_cube: NaiveMemCube,
        messages: MessageList,
        session_id: str | None = None,
        history: MessageList | None = None,
    ) -> list[str]:
        memories = self.mem_reader.get_memory(
            [messages],
            type="chat",
            info={
                "user_id": user_id,
                "session_id": session_id,
                "chat_history": history,
            },
        )
        flattened_memories = [mm for m in memories for mm in m]
        mem_id_list: list[str] = mem_cube.text_mem.add(
            flattened_memories,
            user_name=cube_id,
        )
        return mem_id_list

    def search(
        self,
        user_id: str,
        cube_id: str,
        session_id: str | None = None,
    ) -> None:
        NotImplementedError("Not implemented")

    def _filter_memories_by_threshold(
        self,
        memories: list[TextualMemoryItem],
        threshold: float = 0.30,
        min_num: int = 3,
        memory_type: Literal["OuterMemory"] = "OuterMemory",
    ) -> list[TextualMemoryItem]:
        """
        Filter memories by threshold and type, at least min_num memories for Non-OuterMemory.
        Args:
            memories: list[TextualMemoryItem],
            threshold: float,
            min_num: int,
            memory_type: Literal["OuterMemory"],
        Returns:
            list[TextualMemoryItem]
        """
        sorted_memories = sorted(memories, key=lambda m: m.metadata.relativity, reverse=True)
        filtered_person = [m for m in memories if m.metadata.memory_type != memory_type]
        filtered_outer = [m for m in memories if m.metadata.memory_type == memory_type]
        filtered = []
        per_memory_count = 0
        for m in sorted_memories:
            if m.metadata.relativity >= threshold:
                if m.metadata.memory_type != memory_type:
                    per_memory_count += 1
                filtered.append(m)
        if len(filtered) < min_num:
            filtered = filtered_person[:min_num] + filtered_outer[:min_num]
        else:
            if per_memory_count < min_num:
                filtered += filtered_person[per_memory_count:min_num]
        filtered_memory = sorted(filtered, key=lambda m: m.metadata.relativity, reverse=True)
        return filtered_memory

    def _build_base_system_prompt(
        self,
        base_prompt: str | None = None,
        tone: str = "friendly",
        verbosity: str = "mid",
        mode: str = "enhance",
    ) -> str:
        """
        Build base system prompt without memory references.
        """
        now = datetime.now()
        formatted_date = now.strftime("%Y-%m-%d (%A)")
        sys_body = get_memos_prompt(date=formatted_date, tone=tone, verbosity=verbosity, mode=mode)
        prefix = (base_prompt.strip() + "\n\n") if base_prompt else ""
        return prefix + sys_body

    def _build_system_prompt(
        self,
        memories: list[TextualMemoryItem] | list[str] | None = None,
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
                if isinstance(memory, TextualMemoryItem):
                    text_memory = memory.memory
                else:
                    if not isinstance(memory, str):
                        logger.error("Unexpected memory type.")
                    text_memory = memory
                memory_list.append(f"{i}. {text_memory}")
            memory_context = "\n".join(memory_list)

        if "{memories}" in base_prompt:
            return base_prompt.format(memories=memory_context)
        elif base_prompt and memories:
            # For backward compatibility, append memories if no placeholder is found
            memory_context_with_header = "\n\n## Memories:\n" + memory_context
            return base_prompt + memory_context_with_header
        return base_prompt

    def _build_memory_context(
        self,
        memories_all: list[TextualMemoryItem],
        mode: str = "enhance",
    ) -> str:
        """
        Build memory context to be included in user message.
        """
        if not memories_all:
            return ""

        mem_block_o, mem_block_p = _format_mem_block(memories_all)

        if mode == "enhance":
            return (
                "# Memories\n## PersonalMemory (ordered)\n"
                + mem_block_p
                + "\n## OuterMemory (ordered)\n"
                + mem_block_o
                + "\n\n"
            )
        else:
            mem_block = mem_block_o + "\n" + mem_block_p
            return "# Memories\n## PersonalMemory & OuterMemory (ordered)\n" + mem_block + "\n\n"

    def _extract_references_from_response(self, response: str) -> tuple[str, list[dict]]:
        """
        Extract reference information from the response and return clean text.

        Args:
            response (str): The complete response text.

        Returns:
            tuple[str, list[dict]]: A tuple containing:
                - clean_text: Text with reference markers removed
                - references: List of reference information
        """
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
            logger.error(f"Error extracting references from response: {e}", exc_info=True)
            return response, []

    async def _post_chat_processing(
        self,
        user_id: str,
        cube_id: str,
        query: str,
        full_response: str,
        system_prompt: str,
        time_start: float,
        time_end: float,
        speed_improvement: float,
        current_messages: list,
        mem_cube: NaiveMemCube | None = None,
        session_id: str | None = None,
        history: MessageList | None = None,
    ) -> None:
        """
        Asynchronous processing of logs, notifications and memory additions
        """
        try:
            logger.info(
                f"user_id: {user_id}, cube_id: {cube_id}, current_messages: {current_messages}"
            )
            logger.info(f"user_id: {user_id}, cube_id: {cube_id}, full_response: {full_response}")

            clean_response, extracted_references = self._extract_references_from_response(
                full_response
            )
            logger.info(f"Extracted {len(extracted_references)} references from response")

            # Send chat report notifications asynchronously
            if self.online_bot:
                try:
                    from memos.memos_tools.notification_utils import (
                        send_online_bot_notification_async,
                    )

                    # Prepare notification data
                    chat_data = {
                        "query": query,
                        "user_id": user_id,
                        "cube_id": cube_id,
                        "system_prompt": system_prompt,
                        "full_response": full_response,
                    }

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
                    logger.warning(f"Failed to send chat notification (async): {e}")

            self.add(
                user_id=user_id,
                cube_id=cube_id,
                mem_cube=mem_cube,
                session_id=session_id,
                history=history,
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
            )

            logger.info(f"Post-chat processing completed for user {user_id}")

        except Exception as e:
            logger.error(f"Error in post-chat processing for user {user_id}: {e}", exc_info=True)

    def _start_post_chat_processing(
        self,
        user_id: str,
        cube_id: str,
        query: str,
        full_response: str,
        system_prompt: str,
        time_start: float,
        time_end: float,
        speed_improvement: float,
        current_messages: list,
        mem_cube: NaiveMemCube | None = None,
        session_id: str | None = None,
        history: MessageList | None = None,
    ) -> None:
        """
        Asynchronous processing of logs, notifications and memory additions, handle synchronous and asynchronous environments
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
                            query=query,
                            full_response=full_response,
                            system_prompt=system_prompt,
                            time_start=time_start,
                            time_end=time_end,
                            speed_improvement=speed_improvement,
                            current_messages=current_messages,
                            mem_cube=mem_cube,
                            session_id=session_id,
                            history=history,
                        )
                    )
                finally:
                    loop.close()
            except Exception as e:
                logger.error(
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
                lambda t: logger.error(
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
                # Set as a daemon thread to avoid blocking program exit
                daemon=True,
            )
            thread.start()
