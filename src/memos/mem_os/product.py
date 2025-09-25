import asyncio
import json
import os
import random
import time

from collections.abc import Generator
from datetime import datetime
from typing import Any, Literal

from dotenv import load_dotenv
from transformers import AutoTokenizer

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.context.context import ContextThread
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.core import MOSCore
from memos.mem_os.utils.format_utils import (
    clean_json_response,
    convert_graph_to_tree_forworkmem,
    ensure_unique_tree_ids,
    filter_nodes_by_tree_ids,
    remove_embedding_recursive,
    sort_children_by_memory_type,
)
from memos.mem_os.utils.reference_utils import (
    prepare_reference_data,
    process_streaming_references_complete,
)
from memos.mem_scheduler.schemas.general_schemas import (
    ANSWER_LABEL,
    QUERY_LABEL,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_user.persistent_factory import PersistentUserManagerFactory
from memos.mem_user.user_manager import UserRole
from memos.memories.textual.item import (
    TextualMemoryItem,
)
from memos.templates.mos_prompts import (
    FURTHER_SUGGESTION_PROMPT,
    SUGGESTION_QUERY_PROMPT_EN,
    SUGGESTION_QUERY_PROMPT_ZH,
    get_memos_prompt,
)
from memos.types import MessageList
from memos.utils import timed


logger = get_logger(__name__)

load_dotenv()

CUBE_PATH = os.getenv("MOS_CUBE_PATH", "/tmp/data/")


def _short_id(mem_id: str) -> str:
    return (mem_id or "").split("-")[0] if mem_id else ""


def _format_mem_block(memories_all, max_items: int = 20, max_chars_each: int = 320) -> str:
    """
    Modify TextualMemoryItem Format:
      1:abcd :: [P] text...
      2:ef01 :: [O] text...
    sequence is [i:memId] i; [P]=PersonalMemory / [O]=OuterMemory
    """
    if not memories_all:
        return "(none)", "(none)"

    lines_o = []
    lines_p = []
    for idx, m in enumerate(memories_all[:max_items], 1):
        mid = _short_id(getattr(m, "id", "") or "")
        mtype = getattr(getattr(m, "metadata", {}), "memory_type", None) or getattr(
            m, "metadata", {}
        ).get("memory_type", "")
        tag = "O" if "Outer" in str(mtype) else "P"
        txt = (getattr(m, "memory", "") or "").replace("\n", " ").strip()
        if len(txt) > max_chars_each:
            txt = txt[: max_chars_each - 1] + "…"
        mid = mid or f"mem_{idx}"
        if tag == "O":
            lines_o.append(f"[{idx}:{mid}] :: [{tag}] {txt}\n")
        elif tag == "P":
            lines_p.append(f"[{idx}:{mid}] :: [{tag}] {txt}")
    return "\n".join(lines_o), "\n".join(lines_p)


class MOSProduct(MOSCore):
    """
    The MOSProduct class inherits from MOSCore and manages multiple users.
    Each user has their own configuration and cube access, but shares the same model instances.
    """

    def __init__(
        self,
        default_config: MOSConfig | None = None,
        max_user_instances: int = 1,
        default_cube_config: GeneralMemCubeConfig | None = None,
        online_bot=None,
        error_bot=None,
    ):
        """
        Initialize MOSProduct with an optional default configuration.

        Args:
            default_config (MOSConfig | None): Default configuration for new users
            max_user_instances (int): Maximum number of user instances to keep in memory
            default_cube_config (GeneralMemCubeConfig | None): Default cube configuration for loading cubes
            online_bot: DingDing online_bot function or None if disabled
            error_bot: DingDing error_bot function or None if disabled
        """
        # Initialize with a root config for shared resources
        if default_config is None:
            # Create a minimal config for root user
            root_config = MOSConfig(
                user_id="root",
                session_id="root_session",
                chat_model=default_config.chat_model if default_config else None,
                mem_reader=default_config.mem_reader if default_config else None,
                enable_mem_scheduler=default_config.enable_mem_scheduler
                if default_config
                else False,
                mem_scheduler=default_config.mem_scheduler if default_config else None,
            )
        else:
            root_config = default_config.model_copy(deep=True)
            root_config.user_id = "root"
            root_config.session_id = "root_session"

        # Create persistent user manager BEFORE calling parent constructor
        persistent_user_manager_client = PersistentUserManagerFactory.from_config(
            config_factory=root_config.user_manager
        )

        # Initialize parent MOSCore with root config and persistent user manager
        super().__init__(root_config, user_manager=persistent_user_manager_client)

        # Product-specific attributes
        self.default_config = default_config
        self.default_cube_config = default_cube_config
        self.max_user_instances = max_user_instances
        self.online_bot = online_bot
        self.error_bot = error_bot

        # User-specific data structures
        self.user_configs: dict[str, MOSConfig] = {}
        self.user_cube_access: dict[str, set[str]] = {}  # user_id -> set of cube_ids
        self.user_chat_histories: dict[str, dict] = {}

        # Note: self.user_manager is now the persistent user manager from parent class
        # No need for separate global_user_manager as they are the same instance

        # Initialize tiktoken for streaming
        try:
            # Use gpt2 encoding which is more stable and widely compatible
            self.tokenizer = AutoTokenizer.from_pretrained("Qwen/Qwen3-0.6B")
            logger.info("tokenizer initialized successfully for streaming")
        except Exception as e:
            logger.warning(
                f"Failed to initialize tokenizer, will use character-based chunking: {e}"
            )
            self.tokenizer = None

        # Restore user instances from persistent storage
        self._restore_user_instances(default_cube_config=default_cube_config)
        logger.info(f"User instances restored successfully, now user is {self.mem_cubes.keys()}")

    def _restore_user_instances(
        self, default_cube_config: GeneralMemCubeConfig | None = None
    ) -> None:
        """Restore user instances from persistent storage after service restart.

        Args:
            default_cube_config (GeneralMemCubeConfig | None, optional): Default cube configuration. Defaults to None.
        """
        try:
            # Get all user configurations from persistent storage
            user_configs = self.user_manager.list_user_configs()

            # Get the raw database records for sorting by updated_at
            session = self.user_manager._get_session()
            try:
                from memos.mem_user.persistent_user_manager import UserConfig

                db_configs = session.query(UserConfig).all()
                # Create a mapping of user_id to updated_at timestamp
                updated_at_map = {config.user_id: config.updated_at for config in db_configs}

                # Sort by updated_at timestamp (most recent first) and limit by max_instances
                sorted_configs = sorted(
                    user_configs.items(), key=lambda x: updated_at_map.get(x[0], ""), reverse=True
                )[: self.max_user_instances]
            finally:
                session.close()

            for user_id, config in sorted_configs:
                if user_id != "root":  # Skip root user
                    try:
                        # Store user config and cube access
                        self.user_configs[user_id] = config
                        self._load_user_cube_access(user_id)

                        # Pre-load all cubes for this user with default config
                        self._preload_user_cubes(user_id, default_cube_config)

                        logger.info(
                            f"Restored user configuration and pre-loaded cubes for {user_id}"
                        )

                    except Exception as e:
                        logger.error(f"Failed to restore user configuration for {user_id}: {e}")

        except Exception as e:
            logger.error(f"Error during user instance restoration: {e}")

    def _preload_user_cubes(
        self, user_id: str, default_cube_config: GeneralMemCubeConfig | None = None
    ) -> None:
        """Pre-load all cubes for a user into memory.

        Args:
            user_id (str): The user ID to pre-load cubes for.
            default_cube_config (GeneralMemCubeConfig | None, optional): Default cube configuration. Defaults to None.
        """
        try:
            # Get user's accessible cubes from persistent storage
            accessible_cubes = self.user_manager.get_user_cubes(user_id)

            for cube in accessible_cubes:
                if cube.cube_id not in self.mem_cubes:
                    try:
                        if cube.cube_path and os.path.exists(cube.cube_path):
                            # Pre-load cube with all memory types and default config
                            self.register_mem_cube(
                                cube.cube_path,
                                cube.cube_id,
                                user_id,
                                memory_types=["act_mem"]
                                if self.config.enable_activation_memory
                                else [],
                                default_config=default_cube_config,
                            )
                            logger.info(f"Pre-loaded cube {cube.cube_id} for user {user_id}")
                        else:
                            logger.warning(
                                f"Cube path {cube.cube_path} does not exist for cube {cube.cube_id}, skipping pre-load"
                            )
                    except Exception as e:
                        logger.error(
                            f"Failed to pre-load cube {cube.cube_id} for user {user_id}: {e}",
                            exc_info=True,
                        )

        except Exception as e:
            logger.error(f"Error pre-loading cubes for user {user_id}: {e}", exc_info=True)

    @timed
    def _load_user_cubes(
        self, user_id: str, default_cube_config: GeneralMemCubeConfig | None = None
    ) -> None:
        """Load all cubes for a user into memory.

        Args:
            user_id (str): The user ID to load cubes for.
            default_cube_config (GeneralMemCubeConfig | None, optional): Default cube configuration. Defaults to None.
        """
        # Get user's accessible cubes from persistent storage
        accessible_cubes = self.user_manager.get_user_cubes(user_id)

        for cube in accessible_cubes[:1]:
            if cube.cube_id not in self.mem_cubes:
                try:
                    if cube.cube_path and os.path.exists(cube.cube_path):
                        # Use MOSCore's register_mem_cube method directly with default config
                        # Only load act_mem since text_mem is stored in database
                        self.register_mem_cube(
                            cube.cube_path,
                            cube.cube_id,
                            user_id,
                            memory_types=["act_mem"],
                            default_config=default_cube_config,
                        )
                    else:
                        logger.warning(
                            f"Cube path {cube.cube_path} does not exist for cube {cube.cube_id}"
                        )
                except Exception as e:
                    logger.error(f"Failed to load cube {cube.cube_id} for user {user_id}: {e}")
        logger.info(f"load user {user_id} cubes successfully")

    def _ensure_user_instance(self, user_id: str, max_instances: int | None = None) -> None:
        """
        Ensure user configuration exists, creating it if necessary.

        Args:
            user_id (str): The user ID
            max_instances (int): Maximum instances to keep in memory (overrides class default)
        """
        if user_id in self.user_configs:
            return

        # Try to get config from persistent storage first
        stored_config = self.user_manager.get_user_config(user_id)
        if stored_config:
            self.user_configs[user_id] = stored_config
            self._load_user_cube_access(user_id)
        else:
            # Use default config
            if not self.default_config:
                raise ValueError(f"No configuration available for user {user_id}")
            user_config = self.default_config.model_copy(deep=True)
            user_config.user_id = user_id
            user_config.session_id = f"{user_id}_session"
            self.user_configs[user_id] = user_config
            self._load_user_cube_access(user_id)

        # Apply LRU eviction if needed
        max_instances = max_instances or self.max_user_instances
        if len(self.user_configs) > max_instances:
            # Remove least recently used instance (excluding root)
            user_ids = [uid for uid in self.user_configs if uid != "root"]
            if user_ids:
                oldest_user_id = user_ids[0]
                del self.user_configs[oldest_user_id]
                if oldest_user_id in self.user_cube_access:
                    del self.user_cube_access[oldest_user_id]
                logger.info(f"Removed least recently used user configuration: {oldest_user_id}")

    def _load_user_cube_access(self, user_id: str) -> None:
        """Load user's cube access permissions."""
        try:
            # Get user's accessible cubes from persistent storage
            accessible_cubes = self.user_manager.get_user_cube_access(user_id)
            self.user_cube_access[user_id] = set(accessible_cubes)
        except Exception as e:
            logger.warning(f"Failed to load cube access for user {user_id}: {e}")
            self.user_cube_access[user_id] = set()

    def _get_user_config(self, user_id: str) -> MOSConfig:
        """Get user configuration."""
        if user_id not in self.user_configs:
            self._ensure_user_instance(user_id)
        return self.user_configs[user_id]

    def _validate_user_cube_access(self, user_id: str, cube_id: str) -> None:
        """Validate user has access to the cube."""
        if user_id not in self.user_cube_access:
            self._load_user_cube_access(user_id)

        if cube_id not in self.user_cube_access.get(user_id, set()):
            raise ValueError(f"User '{user_id}' does not have access to cube '{cube_id}'")

    def _validate_user_access(self, user_id: str, cube_id: str | None = None) -> None:
        """Validate user access using MOSCore's built-in validation."""
        # Use MOSCore's built-in user validation
        if cube_id:
            self._validate_cube_access(user_id, cube_id)
        else:
            self._validate_user_exists(user_id)

    def _create_user_config(self, user_id: str, config: MOSConfig) -> MOSConfig:
        """Create a new user configuration."""
        # Create a copy of config with the specific user_id
        user_config = config.model_copy(deep=True)
        user_config.user_id = user_id
        user_config.session_id = f"{user_id}_session"

        # Save configuration to persistent storage
        self.user_manager.save_user_config(user_id, user_config)

        return user_config

    def _get_or_create_user_config(
        self, user_id: str, config: MOSConfig | None = None
    ) -> MOSConfig:
        """Get existing user config or create a new one."""
        if user_id in self.user_configs:
            return self.user_configs[user_id]

        # Try to get config from persistent storage first
        stored_config = self.user_manager.get_user_config(user_id)
        if stored_config:
            return self._create_user_config(user_id, stored_config)

        # Use provided config or default config
        user_config = config or self.default_config
        if not user_config:
            raise ValueError(f"No configuration provided for user {user_id}")

        return self._create_user_config(user_id, user_config)

    def _build_system_prompt(
        self,
        memories_all: list[TextualMemoryItem],
        base_prompt: str | None = None,
        tone: str = "friendly",
        verbosity: str = "mid",
    ) -> str:
        """
        Build custom system prompt for the user with memory references.

        Args:
            user_id (str): The user ID.
            memories (list[TextualMemoryItem]): The memories to build the system prompt.

        Returns:
            str: The custom system prompt.
        """
        # Build base prompt
        # Add memory context if available
        now = datetime.now()
        formatted_date = now.strftime("%Y-%m-%d (%A)")
        sys_body = get_memos_prompt(
            date=formatted_date, tone=tone, verbosity=verbosity, mode="base"
        )
        mem_block_o, mem_block_p = _format_mem_block(memories_all)
        mem_block = mem_block_o + "\n" + mem_block_p
        prefix = (base_prompt.strip() + "\n\n") if base_prompt else ""
        return (
            prefix
            + sys_body
            + "\n\n# Memories\n## PersonalMemory & OuterMemory (ordered)\n"
            + mem_block
        )

    def _build_enhance_system_prompt(
        self,
        user_id: str,
        memories_all: list[TextualMemoryItem],
        tone: str = "friendly",
        verbosity: str = "mid",
    ) -> str:
        """
        Build enhance prompt for the user with memory references.
        """
        now = datetime.now()
        formatted_date = now.strftime("%Y-%m-%d (%A)")
        sys_body = get_memos_prompt(
            date=formatted_date, tone=tone, verbosity=verbosity, mode="enhance"
        )
        mem_block_o, mem_block_p = _format_mem_block(memories_all)
        return (
            sys_body
            + "\n\n# Memories\n## PersonalMemory (ordered)\n"
            + mem_block_p
            + "\n## OuterMemory (ordered)\n"
            + mem_block_o
        )

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

    def _chunk_response_with_tiktoken(
        self, response: str, chunk_size: int = 5
    ) -> Generator[str, None, None]:
        """
        Chunk response using tiktoken for proper token-based streaming.

        Args:
            response (str): The response text to chunk.
            chunk_size (int): Number of tokens per chunk.

        Yields:
            str: Chunked text pieces.
        """
        if self.tokenizer:
            # Use tiktoken for proper token-based chunking
            tokens = self.tokenizer.encode(response)

            for i in range(0, len(tokens), chunk_size):
                token_chunk = tokens[i : i + chunk_size]
                chunk_text = self.tokenizer.decode(token_chunk)
                yield chunk_text
        else:
            # Fallback to character-based chunking
            char_chunk_size = chunk_size * 4  # Approximate character to token ratio
            for i in range(0, len(response), char_chunk_size):
                yield response[i : i + char_chunk_size]

    def _send_message_to_scheduler(
        self,
        user_id: str,
        mem_cube_id: str,
        query: str,
        label: str,
    ):
        """
        Send message to scheduler.
        args:
            user_id: str,
            mem_cube_id: str,
            query: str,
        """

        if self.enable_mem_scheduler and (self.mem_scheduler is not None):
            message_item = ScheduleMessageItem(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=self.mem_cubes[mem_cube_id],
                label=label,
                content=query,
                timestamp=datetime.utcnow(),
            )
            self.mem_scheduler.submit_messages(messages=[message_item])

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

            self._send_message_to_scheduler(
                user_id=user_id, mem_cube_id=cube_id, query=clean_response, label=ANSWER_LABEL
            )

            self.add(
                user_id=user_id,
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
                mem_cube_id=cube_id,
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

    def register_mem_cube(
        self,
        mem_cube_name_or_path_or_object: str | GeneralMemCube,
        mem_cube_id: str | None = None,
        user_id: str | None = None,
        memory_types: list[Literal["text_mem", "act_mem", "para_mem"]] | None = None,
        default_config: GeneralMemCubeConfig | None = None,
    ) -> None:
        """
        Register a MemCube with the MOS.

        Args:
            mem_cube_name_or_path_or_object (str | GeneralMemCube): The name, path, or GeneralMemCube object to register.
            mem_cube_id (str, optional): The identifier for the MemCube. If not provided, a default ID is used.
            user_id (str, optional): The user ID to register the cube for.
            memory_types (list[str], optional): List of memory types to load.
                If None, loads all available memory types.
                Options: ["text_mem", "act_mem", "para_mem"]
            default_config (GeneralMemCubeConfig, optional): Default configuration for the cube.
        """
        # Handle different input types
        if isinstance(mem_cube_name_or_path_or_object, GeneralMemCube):
            # Direct GeneralMemCube object provided
            mem_cube = mem_cube_name_or_path_or_object
            if mem_cube_id is None:
                mem_cube_id = f"cube_{id(mem_cube)}"  # Generate a unique ID
        else:
            # String path provided
            mem_cube_name_or_path = mem_cube_name_or_path_or_object
            if mem_cube_id is None:
                mem_cube_id = mem_cube_name_or_path

            if mem_cube_id in self.mem_cubes:
                logger.info(f"MemCube with ID {mem_cube_id} already in MOS, skip install.")
                return

            # Create MemCube from path
            time_start = time.time()
            if os.path.exists(mem_cube_name_or_path):
                mem_cube = GeneralMemCube.init_from_dir(
                    mem_cube_name_or_path, memory_types, default_config
                )
                logger.info(
                    f"time register_mem_cube: init_from_dir time is: {time.time() - time_start}"
                )
            else:
                logger.warning(
                    f"MemCube {mem_cube_name_or_path} does not exist, try to init from remote repo."
                )
                mem_cube = GeneralMemCube.init_from_remote_repo(
                    mem_cube_name_or_path, memory_types=memory_types, default_config=default_config
                )

        # Register the MemCube
        logger.info(
            f"Registering MemCube {mem_cube_id} with cube config {mem_cube.config.model_dump(mode='json')}"
        )
        time_start = time.time()
        self.mem_cubes[mem_cube_id] = mem_cube
        time_end = time.time()
        logger.info(f"time register_mem_cube: add mem_cube time is: {time_end - time_start}")

    def user_register(
        self,
        user_id: str,
        user_name: str | None = None,
        config: MOSConfig | None = None,
        interests: str | None = None,
        default_mem_cube: GeneralMemCube | None = None,
        default_cube_config: GeneralMemCubeConfig | None = None,
        mem_cube_id: str | None = None,
    ) -> dict[str, str]:
        """Register a new user with configuration and default cube.

        Args:
            user_id (str): The user ID for registration.
            user_name (str): The user name for registration.
            config (MOSConfig | None, optional): User-specific configuration. Defaults to None.
            interests (str | None, optional): User interests as string. Defaults to None.
            default_mem_cube (GeneralMemCube | None, optional): Default memory cube. Defaults to None.
            default_cube_config (GeneralMemCubeConfig | None, optional): Default cube configuration. Defaults to None.

        Returns:
            dict[str, str]: Registration result with status and message.
        """
        try:
            # Use provided config or default config
            user_config = config or self.default_config
            if not user_config:
                return {
                    "status": "error",
                    "message": "No configuration provided for user registration",
                }
            if not user_name:
                user_name = user_id

            # Create user with configuration using persistent user manager
            self.user_manager.create_user_with_config(user_id, user_config, UserRole.USER, user_id)

            # Create user configuration
            user_config = self._create_user_config(user_id, user_config)

            # Create a default cube for the user using MOSCore's methods
            default_cube_name = f"{user_name}_{user_id}_default_cube"
            mem_cube_name_or_path = os.path.join(CUBE_PATH, default_cube_name)
            default_cube_id = self.create_cube_for_user(
                cube_name=default_cube_name,
                owner_id=user_id,
                cube_path=mem_cube_name_or_path,
                cube_id=mem_cube_id,
            )
            time_start = time.time()
            if default_mem_cube:
                try:
                    default_mem_cube.dump(mem_cube_name_or_path, memory_types=[])
                except Exception as e:
                    logger.error(f"Failed to dump default cube: {e}")
            time_end = time.time()
            logger.info(f"time user_register: dump default cube time is: {time_end - time_start}")
            # Register the default cube with MOS
            self.register_mem_cube(
                mem_cube_name_or_path_or_object=default_mem_cube,
                mem_cube_id=default_cube_id,
                user_id=user_id,
                memory_types=["act_mem"] if self.config.enable_activation_memory else [],
                default_config=default_cube_config,  # use default cube config
            )

            # Add interests to the default cube if provided
            if interests:
                self.add(memory_content=interests, mem_cube_id=default_cube_id, user_id=user_id)

            return {
                "status": "success",
                "message": f"User {user_name} registered successfully with default cube {default_cube_id}",
                "user_id": user_id,
                "default_cube_id": default_cube_id,
            }

        except Exception as e:
            return {"status": "error", "message": f"Failed to register user: {e!s}"}

    def _get_further_suggestion(self, message: MessageList | None = None) -> list[str]:
        """Get further suggestion prompt."""
        try:
            dialogue_info = "\n".join([f"{msg['role']}: {msg['content']}" for msg in message[-2:]])
            further_suggestion_prompt = FURTHER_SUGGESTION_PROMPT.format(dialogue=dialogue_info)
            message_list = [{"role": "system", "content": further_suggestion_prompt}]
            response = self.chat_llm.generate(message_list)
            clean_response = clean_json_response(response)
            response_json = json.loads(clean_response)
            return response_json["query"]
        except Exception as e:
            logger.error(f"Error getting further suggestion: {e}", exc_info=True)
            return []

    def get_suggestion_query(
        self, user_id: str, language: str = "zh", message: MessageList | None = None
    ) -> list[str]:
        """Get suggestion query from LLM.
        Args:
            user_id (str): User ID.
            language (str): Language for suggestions ("zh" or "en").

        Returns:
            list[str]: The suggestion query list.
        """
        if message:
            further_suggestion = self._get_further_suggestion(message)
            return further_suggestion
        if language == "zh":
            suggestion_prompt = SUGGESTION_QUERY_PROMPT_ZH
        else:  # English
            suggestion_prompt = SUGGESTION_QUERY_PROMPT_EN
        text_mem_result = super().search("my recently memories", user_id=user_id, top_k=3)[
            "text_mem"
        ]
        if text_mem_result:
            memories = "\n".join([m.memory[:200] for m in text_mem_result[0]["memories"]])
        else:
            memories = ""
        message_list = [{"role": "system", "content": suggestion_prompt.format(memories=memories)}]
        response = self.chat_llm.generate(message_list)
        clean_response = clean_json_response(response)
        response_json = json.loads(clean_response)
        return response_json["query"]

    def chat(
        self,
        query: str,
        user_id: str,
        cube_id: str | None = None,
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
        self._load_user_cubes(user_id, self.default_cube_config)
        time_start = time.time()
        memories_result = super().search(
            query,
            user_id,
            install_cube_ids=[cube_id] if cube_id else None,
            top_k=top_k,
            mode="fine",
            internet_search=internet_search,
            moscube=moscube,
            session_id=session_id,
        )["text_mem"]

        memories_list = []
        if memories_result:
            memories_list = memories_result[0]["memories"]
            memories_list = self._filter_memories_by_threshold(memories_list, threshold)
            new_memories_list = []
            for m in memories_list:
                m.metadata.embedding = []
                new_memories_list.append(m)
            memories_list = new_memories_list
        system_prompt = super()._build_system_prompt(memories_list, base_prompt)
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
            query=query,
            full_response=response,
            system_prompt=system_prompt,
            time_start=time_start,
            time_end=time_end,
            speed_improvement=0.0,
            current_messages=current_messages,
        )
        return response, memories_list

    def chat_with_references(
        self,
        query: str,
        user_id: str,
        cube_id: str | None = None,
        history: MessageList | None = None,
        top_k: int = 20,
        internet_search: bool = False,
        moscube: bool = False,
        session_id: str | None = None,
    ) -> Generator[str, None, None]:
        """
        Chat with LLM with memory references and streaming output.

        Args:
            query (str): Query string.
            user_id (str): User ID.
            cube_id (str, optional): Custom cube ID for user.
            history (MessageList, optional): Chat history.

        Returns:
            Generator[str, None, None]: The response string generator with reference processing.
        """

        self._load_user_cubes(user_id, self.default_cube_config)
        time_start = time.time()
        memories_list = []
        yield f"data: {json.dumps({'type': 'status', 'data': '0'})}\n\n"
        memories_result = super().search(
            query,
            user_id,
            install_cube_ids=[cube_id] if cube_id else None,
            top_k=top_k,
            mode="fine",
            internet_search=internet_search,
            moscube=moscube,
            session_id=session_id,
        )["text_mem"]

        yield f"data: {json.dumps({'type': 'status', 'data': '1'})}\n\n"
        search_time_end = time.time()
        logger.info(
            f"time chat: search text_mem time user_id: {user_id} time is: {search_time_end - time_start}"
        )
        self._send_message_to_scheduler(
            user_id=user_id, mem_cube_id=cube_id, query=query, label=QUERY_LABEL
        )
        if memories_result:
            memories_list = memories_result[0]["memories"]
            memories_list = self._filter_memories_by_threshold(memories_list)

        reference = prepare_reference_data(memories_list)
        yield f"data: {json.dumps({'type': 'reference', 'data': reference})}\n\n"
        # Build custom system prompt with relevant memories)
        system_prompt = self._build_enhance_system_prompt(user_id, memories_list)
        # Get chat history
        if user_id not in self.chat_history_manager:
            self._register_chat_history(user_id, session_id)

        chat_history = self.chat_history_manager[user_id]
        if history:
            chat_history.chat_history = history[-20:]
        current_messages = [
            {"role": "system", "content": system_prompt},
            *chat_history.chat_history,
            {"role": "user", "content": query},
        ]
        logger.info(
            f"user_id: {user_id}, cube_id: {cube_id}, current_system_prompt: {system_prompt}"
        )
        yield f"data: {json.dumps({'type': 'status', 'data': '2'})}\n\n"
        # Generate response with custom prompt
        past_key_values = None
        response_stream = None
        if self.config.enable_activation_memory:
            # Handle activation memory (copy MOSCore logic)
            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube.act_mem and mem_cube_id == cube_id:
                    kv_cache = next(iter(mem_cube.act_mem.get_all()), None)
                    past_key_values = (
                        kv_cache.memory if (kv_cache and hasattr(kv_cache, "memory")) else None
                    )
                    if past_key_values is not None:
                        logger.info("past_key_values is not None will apply to chat")
                    else:
                        logger.info("past_key_values is None will not apply to chat")
                    break
            if self.config.chat_model.backend == "huggingface":
                response_stream = self.chat_llm.generate_stream(
                    current_messages, past_key_values=past_key_values
                )
            elif self.config.chat_model.backend == "vllm":
                response_stream = self.chat_llm.generate_stream(current_messages)
        else:
            if self.config.chat_model.backend in ["huggingface", "vllm", "openai"]:
                response_stream = self.chat_llm.generate_stream(current_messages)
            else:
                response_stream = self.chat_llm.generate(current_messages)

        time_end = time.time()
        chat_time_end = time.time()
        logger.info(
            f"time chat: chat time user_id: {user_id} time is: {chat_time_end - search_time_end}"
        )
        # Simulate streaming output with proper reference handling using tiktoken

        # Initialize buffer for streaming
        buffer = ""
        full_response = ""
        token_count = 0
        # Use tiktoken for proper token-based chunking
        if self.config.chat_model.backend not in ["huggingface", "vllm", "openai"]:
            # For non-huggingface backends, we need to collect the full response first
            full_response_text = ""
            for chunk in response_stream:
                if chunk in ["<think>", "</think>"]:
                    continue
                full_response_text += chunk
            response_stream = self._chunk_response_with_tiktoken(full_response_text, chunk_size=5)
        for chunk in response_stream:
            if chunk in ["<think>", "</think>"]:
                continue
            token_count += 1
            buffer += chunk
            full_response += chunk

            # Process buffer to ensure complete reference tags
            processed_chunk, remaining_buffer = process_streaming_references_complete(buffer)

            if processed_chunk:
                chunk_data = f"data: {json.dumps({'type': 'text', 'data': processed_chunk}, ensure_ascii=False)}\n\n"
                yield chunk_data
                buffer = remaining_buffer

        # Process any remaining buffer
        if buffer:
            processed_chunk, remaining_buffer = process_streaming_references_complete(buffer)
            if processed_chunk:
                chunk_data = f"data: {json.dumps({'type': 'text', 'data': processed_chunk}, ensure_ascii=False)}\n\n"
                yield chunk_data

        # set kvcache improve speed
        speed_improvement = round(float((len(system_prompt) / 2) * 0.0048 + 44.5), 1)
        total_time = round(float(time_end - time_start), 1)

        yield f"data: {json.dumps({'type': 'time', 'data': {'total_time': total_time, 'speed_improvement': f'{speed_improvement}%'}})}\n\n"
        # get further suggestion
        current_messages.append({"role": "assistant", "content": full_response})
        further_suggestion = self._get_further_suggestion(current_messages)
        logger.info(f"further_suggestion: {further_suggestion}")
        yield f"data: {json.dumps({'type': 'suggestion', 'data': further_suggestion})}\n\n"
        yield f"data: {json.dumps({'type': 'end'})}\n\n"

        # Asynchronous processing of logs, notifications and memory additions
        self._start_post_chat_processing(
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

    def get_all(
        self,
        user_id: str,
        memory_type: Literal["text_mem", "act_mem", "param_mem", "para_mem"],
        mem_cube_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Get all memory items for a user.

        Args:
            user_id (str): The ID of the user.
            cube_id (str | None, optional): The ID of the cube. Defaults to None.
            memory_type (Literal["text_mem", "act_mem", "param_mem"]): The type of memory to get.

        Returns:
            list[dict[str, Any]]: A list of memory items with cube_id and memories structure.
        """

        # Load user cubes if not already loaded
        self._load_user_cubes(user_id, self.default_cube_config)
        time_start = time.time()
        memory_list = super().get_all(
            mem_cube_id=mem_cube_ids[0] if mem_cube_ids else None, user_id=user_id
        )[memory_type]
        get_all_time_end = time.time()
        logger.info(
            f"time get_all: get_all time user_id: {user_id} time is: {get_all_time_end - time_start}"
        )
        reformat_memory_list = []
        if memory_type == "text_mem":
            for memory in memory_list:
                memories = remove_embedding_recursive(memory["memories"])
                custom_type_ratios = {
                    "WorkingMemory": 0.20,
                    "LongTermMemory": 0.40,
                    "UserMemory": 0.40,
                }
                tree_result, node_type_count = convert_graph_to_tree_forworkmem(
                    memories, target_node_count=200, type_ratios=custom_type_ratios
                )
                # Ensure all node IDs are unique in the tree structure
                tree_result = ensure_unique_tree_ids(tree_result)
                memories_filtered = filter_nodes_by_tree_ids(tree_result, memories)
                children = tree_result["children"]
                children_sort = sort_children_by_memory_type(children)
                tree_result["children"] = children_sort
                memories_filtered["tree_structure"] = tree_result
                reformat_memory_list.append(
                    {
                        "cube_id": memory["cube_id"],
                        "memories": [memories_filtered],
                        "memory_statistics": node_type_count,
                    }
                )
        elif memory_type == "act_mem":
            memories_list = []
            act_mem_params = self.mem_cubes[mem_cube_ids[0]].act_mem.get_all()
            if act_mem_params:
                memories_data = act_mem_params[0].model_dump()
                records = memories_data.get("records", [])
                for record in records["text_memories"]:
                    memories_list.append(
                        {
                            "id": memories_data["id"],
                            "text": record,
                            "create_time": records["timestamp"],
                            "size": random.randint(1, 20),
                            "modify_times": 1,
                        }
                    )
            reformat_memory_list.append(
                {
                    "cube_id": "xxxxxxxxxxxxxxxx" if not mem_cube_ids else mem_cube_ids[0],
                    "memories": memories_list,
                }
            )
        elif memory_type == "para_mem":
            act_mem_params = self.mem_cubes[mem_cube_ids[0]].act_mem.get_all()
            logger.info(f"act_mem_params: {act_mem_params}")
            reformat_memory_list.append(
                {
                    "cube_id": "xxxxxxxxxxxxxxxx" if not mem_cube_ids else mem_cube_ids[0],
                    "memories": act_mem_params[0].model_dump(),
                }
            )
        make_format_time_end = time.time()
        logger.info(
            f"time get_all: make_format time user_id: {user_id} time is: {make_format_time_end - get_all_time_end}"
        )
        return reformat_memory_list

    def _get_subgraph(
        self, query: str, mem_cube_id: str, user_id: str | None = None, top_k: int = 5
    ) -> list[dict[str, Any]]:
        result = {"para_mem": [], "act_mem": [], "text_mem": []}
        if self.config.enable_textual_memory and self.mem_cubes[mem_cube_id].text_mem:
            result["text_mem"].append(
                {
                    "cube_id": mem_cube_id,
                    "memories": self.mem_cubes[mem_cube_id].text_mem.get_relevant_subgraph(
                        query, top_k=top_k
                    ),
                }
            )
        return result

    def get_subgraph(
        self,
        user_id: str,
        query: str,
        mem_cube_ids: list[str] | None = None,
        top_k: int = 20,
    ) -> list[dict[str, Any]]:
        """Get all memory items for a user.

        Args:
            user_id (str): The ID of the user.
            cube_id (str | None, optional): The ID of the cube. Defaults to None.
            mem_cube_ids (list[str], optional): The IDs of the cubes. Defaults to None.

        Returns:
            list[dict[str, Any]]: A list of memory items with cube_id and memories structure.
        """

        # Load user cubes if not already loaded
        self._load_user_cubes(user_id, self.default_cube_config)
        memory_list = self._get_subgraph(
            query=query, mem_cube_id=mem_cube_ids[0], user_id=user_id, top_k=top_k
        )["text_mem"]
        reformat_memory_list = []
        for memory in memory_list:
            memories = remove_embedding_recursive(memory["memories"])
            custom_type_ratios = {"WorkingMemory": 0.20, "LongTermMemory": 0.40, "UserMemory": 0.4}
            tree_result, node_type_count = convert_graph_to_tree_forworkmem(
                memories, target_node_count=150, type_ratios=custom_type_ratios
            )
            # Ensure all node IDs are unique in the tree structure
            tree_result = ensure_unique_tree_ids(tree_result)
            memories_filtered = filter_nodes_by_tree_ids(tree_result, memories)
            children = tree_result["children"]
            children_sort = sort_children_by_memory_type(children)
            tree_result["children"] = children_sort
            memories_filtered["tree_structure"] = tree_result
            reformat_memory_list.append(
                {
                    "cube_id": memory["cube_id"],
                    "memories": [memories_filtered],
                    "memory_statistics": node_type_count,
                }
            )

        return reformat_memory_list

    def search(
        self,
        query: str,
        user_id: str,
        install_cube_ids: list[str] | None = None,
        top_k: int = 10,
        mode: Literal["fast", "fine"] = "fast",
        session_id: str | None = None,
    ):
        """Search memories for a specific user."""

        # Load user cubes if not already loaded
        time_start = time.time()
        self._load_user_cubes(user_id, self.default_cube_config)
        load_user_cubes_time_end = time.time()
        logger.info(
            f"time search: load_user_cubes time user_id: {user_id} time is: {load_user_cubes_time_end - time_start}"
        )
        search_result = super().search(
            query, user_id, install_cube_ids, top_k, mode=mode, session_id=session_id
        )
        search_time_end = time.time()
        logger.info(
            f"time search: search text_mem time user_id: {user_id} time is: {search_time_end - load_user_cubes_time_end}"
        )
        text_memory_list = search_result["text_mem"]
        reformat_memory_list = []
        for memory in text_memory_list:
            memories_list = []
            for data in memory["memories"]:
                memories = data.model_dump()
                memories["ref_id"] = f"[{memories['id'].split('-')[0]}]"
                memories["metadata"]["embedding"] = []
                memories["metadata"]["sources"] = []
                memories["metadata"]["ref_id"] = f"[{memories['id'].split('-')[0]}]"
                memories["metadata"]["id"] = memories["id"]
                memories["metadata"]["memory"] = memories["memory"]
                memories_list.append(memories)
            reformat_memory_list.append({"cube_id": memory["cube_id"], "memories": memories_list})
        logger.info(f"search memory list is : {reformat_memory_list}")
        search_result["text_mem"] = reformat_memory_list
        time_end = time.time()
        logger.info(
            f"time search: total time for user_id: {user_id} time is: {time_end - time_start}"
        )
        return search_result

    def add(
        self,
        user_id: str,
        messages: MessageList | None = None,
        memory_content: str | None = None,
        doc_path: str | None = None,
        mem_cube_id: str | None = None,
        source: str | None = None,
        user_profile: bool = False,
        session_id: str | None = None,
    ):
        """Add memory for a specific user."""

        # Load user cubes if not already loaded
        self._load_user_cubes(user_id, self.default_cube_config)
        result = super().add(
            messages, memory_content, doc_path, mem_cube_id, user_id, session_id=session_id
        )
        if user_profile:
            try:
                user_interests = memory_content.split("'userInterests': '")[1].split("', '")[0]
                user_interests = user_interests.replace(",", " ")
                user_profile_memories = self.mem_cubes[
                    mem_cube_id
                ].text_mem.internet_retriever.retrieve_from_internet(query=user_interests, top_k=5)
                for memory in user_profile_memories:
                    self.mem_cubes[mem_cube_id].text_mem.add(memory)
            except Exception as e:
                logger.error(
                    f"Failed to retrieve user profile: {e}, memory_content: {memory_content}"
                )

        return result

    def list_users(self) -> list:
        """List all registered users."""
        return self.user_manager.list_users()

    def get_user_info(self, user_id: str) -> dict:
        """Get user information including accessible cubes."""
        # Use MOSCore's built-in user validation
        # Validate user access
        self._validate_user_access(user_id)

        result = super().get_user_info()

        return result

    def share_cube_with_user(self, cube_id: str, owner_user_id: str, target_user_id: str) -> bool:
        """Share a cube with another user."""
        # Use MOSCore's built-in cube access validation
        self._validate_cube_access(owner_user_id, cube_id)

        result = super().share_cube_with_user(cube_id, target_user_id)

        return result

    def clear_user_chat_history(self, user_id: str) -> None:
        """Clear chat history for a specific user."""
        # Validate user access
        self._validate_user_access(user_id)

        super().clear_messages(user_id)

    def update_user_config(self, user_id: str, config: MOSConfig) -> bool:
        """Update user configuration.

        Args:
            user_id (str): The user ID.
            config (MOSConfig): The new configuration.

        Returns:
            bool: True if successful, False otherwise.
        """
        try:
            # Save to persistent storage
            success = self.user_manager.save_user_config(user_id, config)
            if success:
                # Update in-memory config
                self.user_configs[user_id] = config
                logger.info(f"Updated configuration for user {user_id}")

            return success
        except Exception as e:
            logger.error(f"Failed to update user config for {user_id}: {e}")
            return False

    def get_user_config(self, user_id: str) -> MOSConfig | None:
        """Get user configuration.

        Args:
            user_id (str): The user ID.

        Returns:
            MOSConfig | None: The user's configuration or None if not found.
        """
        return self.user_manager.get_user_config(user_id)

    def get_active_user_count(self) -> int:
        """Get the number of active user configurations in memory."""
        return len(self.user_configs)

    def get_user_instance_info(self) -> dict[str, Any]:
        """Get information about user configurations in memory."""
        return {
            "active_instances": len(self.user_configs),
            "max_instances": self.max_user_instances,
            "user_ids": list(self.user_configs.keys()),
            "lru_order": list(self.user_configs.keys()),  # OrderedDict maintains insertion order
        }
