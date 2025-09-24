import json
import os
import time

from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Literal

from memos.configs.mem_os import MOSConfig
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_reader.factory import MemReaderFactory
from memos.mem_scheduler.general_scheduler import GeneralScheduler
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.mem_scheduler.schemas.general_schemas import (
    ADD_LABEL,
    ANSWER_LABEL,
    QUERY_LABEL,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_user.user_manager import UserManager, UserRole
from memos.memories.activation.item import ActivationMemoryItem
from memos.memories.parametric.item import ParametricMemoryItem
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.memos_tools.thread_safe_dict_segment import OptimizedThreadSafeDict
from memos.templates.mos_prompts import QUERY_REWRITING_PROMPT
from memos.types import ChatHistory, MessageList, MOSSearchResult


logger = get_logger(__name__)


class MOSCore:
    """
    The MOSCore (Memory Operating System Core) class manages multiple MemCube objects and their operations.
    It provides methods for creating, searching, updating, and deleting MemCubes, supporting multi-user scenarios.
    MOSCore acts as an operating system layer for handling and orchestrating MemCube instances.
    """

    def __init__(self, config: MOSConfig, user_manager: UserManager | None = None):
        self.config = config
        self.user_id = config.user_id
        self.session_id = config.session_id
        self.chat_llm = LLMFactory.from_config(config.chat_model)
        self.mem_reader = MemReaderFactory.from_config(config.mem_reader)
        self.chat_history_manager: dict[str, ChatHistory] = {}
        # use thread safe dict for multi-user product-server scenario
        self.mem_cubes: OptimizedThreadSafeDict[str, GeneralMemCube] = (
            OptimizedThreadSafeDict() if user_manager is not None else {}
        )
        self._register_chat_history()

        # Use provided user_manager or create a new one
        if user_manager is not None:
            self.user_manager = user_manager
        else:
            self.user_manager = UserManager(user_id=self.user_id if self.user_id else "root")

        # Validate user exists
        if not self.user_manager.validate_user(self.user_id):
            raise ValueError(
                f"User '{self.user_id}' does not exist or is inactive. Please create user first."
            )

        # Initialize mem_scheduler
        self._mem_scheduler_lock = Lock()
        self.enable_mem_scheduler = self.config.get("enable_mem_scheduler", False)
        if self.enable_mem_scheduler:
            self._mem_scheduler = self._initialize_mem_scheduler()
            self._mem_scheduler.mem_cubes = self.mem_cubes
        else:
            self._mem_scheduler: GeneralScheduler = None

        logger.info(f"MOS initialized for user: {self.user_id}")

    @property
    def mem_scheduler(self) -> GeneralScheduler:
        """Lazy-loaded property for memory scheduler."""
        if self.enable_mem_scheduler and self._mem_scheduler is None:
            self._initialize_mem_scheduler()
        self._mem_scheduler.mem_cubes = self.mem_cubes
        return self._mem_scheduler

    @mem_scheduler.setter
    def mem_scheduler(self, value: GeneralScheduler | None) -> None:
        """Setter for memory scheduler with validation.

        Args:
            value: GeneralScheduler instance or None to disable
        Raises:
            TypeError: If value is neither GeneralScheduler nor None
        """
        with self._mem_scheduler_lock:
            if value is not None and not isinstance(value, GeneralScheduler):
                raise TypeError(f"Expected GeneralScheduler or None, got {type(value)}")

            self._mem_scheduler = value
            self._mem_scheduler.mem_cubes = self.mem_cubes

            if value:
                logger.info("Memory scheduler manually set")
            else:
                logger.debug("Memory scheduler cleared")

    def _initialize_mem_scheduler(self) -> GeneralScheduler:
        """Initialize the memory scheduler on first access."""
        if not self.config.enable_mem_scheduler:
            logger.debug("Memory scheduler is disabled in config")
            self._mem_scheduler = None
            return self._mem_scheduler
        elif not hasattr(self.config, "mem_scheduler"):
            logger.error("Config of Memory scheduler is not available")
            self._mem_scheduler = None
            return self._mem_scheduler
        else:
            logger.info("Initializing memory scheduler...")
            scheduler_config = self.config.mem_scheduler
            self._mem_scheduler = SchedulerFactory.from_config(scheduler_config)
            # Validate required components
            if not hasattr(self.mem_reader, "llm"):
                raise AttributeError(
                    f"Memory reader of type {type(self.mem_reader).__name__} "
                    "missing required 'llm' attribute"
                )
                self._mem_scheduler.initialize_modules(
                    chat_llm=self.chat_llm,
                    process_llm=self.chat_llm,
                    db_engine=self.user_manager.engine,
                )
            else:
                # Configure scheduler general_modules
                self._mem_scheduler.initialize_modules(
                    chat_llm=self.chat_llm,
                    process_llm=self.mem_reader.llm,
                    db_engine=self.user_manager.engine,
                )
            self._mem_scheduler.start()
            return self._mem_scheduler

    def mem_scheduler_on(self) -> bool:
        if not self.config.enable_mem_scheduler or self._mem_scheduler is None:
            logger.error("Cannot start scheduler: disabled in configuration")

        try:
            self._mem_scheduler.start()
            logger.info("Memory scheduler service started")
            return True
        except Exception as e:
            logger.error(f"Failed to start scheduler: {e!s}")
            return False

    def mem_scheduler_off(self) -> bool:
        if not self.config.enable_mem_scheduler:
            logger.error("Cannot stop scheduler: disabled in configuration")

        if self._mem_scheduler is None:
            logger.warning("No scheduler instance to stop")
            return False

        try:
            self._mem_scheduler.stop()
            logger.info("Memory scheduler service stopped")
            return True
        except Exception as e:
            logger.error(f"Failed to stop scheduler: {e!s}")
            return False

    def mem_reorganizer_on(self) -> bool:
        pass

    def mem_reorganizer_off(self) -> bool:
        """temporally implement"""
        for mem_cube in self.mem_cubes.values():
            logger.info(f"try to close reorganizer for {mem_cube.text_mem.config.cube_id}")
            if mem_cube.text_mem and mem_cube.text_mem.is_reorganize:
                logger.info(f"close reorganizer for {mem_cube.text_mem.config.cube_id}")
                mem_cube.text_mem.memory_manager.close()
                mem_cube.text_mem.memory_manager.wait_reorganizer()

    def mem_reorganizer_wait(self) -> bool:
        for mem_cube in self.mem_cubes.values():
            logger.info(f"try to close reorganizer for {mem_cube.text_mem.config.cube_id}")
            if mem_cube.text_mem and mem_cube.text_mem.is_reorganize:
                logger.info(f"close reorganizer for {mem_cube.text_mem.config.cube_id}")
                mem_cube.text_mem.memory_manager.wait_reorganizer()

    def _register_chat_history(
        self, user_id: str | None = None, session_id: str | None = None
    ) -> None:
        """Initialize chat history with user ID."""
        self.chat_history_manager[user_id] = ChatHistory(
            user_id=user_id if user_id is not None else self.user_id,
            session_id=session_id if session_id is not None else self.session_id,
            created_at=datetime.utcnow(),
            total_messages=0,
            chat_history=[],
        )

    def _validate_user_exists(self, user_id: str) -> None:
        """Validate user exists and is active.

        Args:
            user_id (str): The user ID to validate.

        Raises:
            ValueError: If user doesn't exist or is inactive.
        """
        if not self.user_manager.validate_user(user_id):
            raise ValueError(
                f"User '{user_id}' does not exist or is inactive. Please register the user first."
            )

    def _validate_cube_access(self, user_id: str, cube_id: str) -> None:
        """Validate user has access to the cube.

        Args:
            user_id (str): The user ID to validate.
            cube_id (str): The cube ID to validate.

        Raises:
            ValueError: If user doesn't have access to the cube.
        """
        # First validate user exists
        self._validate_user_exists(user_id)

        # Then validate cube access
        if not self.user_manager.validate_user_cube_access(user_id, cube_id):
            raise ValueError(
                f"User '{user_id}' does not have access to cube '{cube_id}'. Please register the cube first or request access."
            )

    def _get_all_documents(self, path: str) -> list[str]:
        """Get all documents from path.

        Args:
            path (str): The path to get documents.

        Returns:
            list[str]: The list of documents.
        """
        documents = []

        path_obj = Path(path)
        doc_extensions = {".txt", ".pdf", ".json", ".md", ".ppt", ".pptx"}
        for file_path in path_obj.rglob("*"):
            if file_path.is_file() and (file_path.suffix.lower() in doc_extensions):
                documents.append(str(file_path))
        return documents

    def chat(self, query: str, user_id: str | None = None, base_prompt: str | None = None) -> str:
        """
        Chat with the MOS.

        Args:
            query (str): The user's query.
            user_id (str, optional): The user ID for the chat session. Defaults to the user ID from the config.
            base_prompt (str, optional): A custom base prompt to use for the chat.
                It can be a template string with a `{memories}` placeholder.
                If not provided, a default prompt is used.

        Returns:
            str: The response from the MOS.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
        user_cube_ids = [cube.cube_id for cube in accessible_cubes]
        if target_user_id not in self.chat_history_manager:
            self._register_chat_history(target_user_id)

        chat_history = self.chat_history_manager[target_user_id]

        if self.config.enable_textual_memory and self.mem_cubes:
            memories_all = []
            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube_id not in user_cube_ids:
                    continue
                if not mem_cube.text_mem:
                    continue

                # submit message to scheduler
                if self.enable_mem_scheduler and self.mem_scheduler is not None:
                    message_item = ScheduleMessageItem(
                        user_id=target_user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=mem_cube,
                        label=QUERY_LABEL,
                        content=query,
                        timestamp=datetime.utcnow(),
                    )
                    self.mem_scheduler.submit_messages(messages=[message_item])

                memories = mem_cube.text_mem.search(
                    query,
                    top_k=self.config.top_k,
                    info={
                        "user_id": target_user_id,
                        "session_id": self.session_id,
                        "chat_history": chat_history.chat_history,
                    },
                )
                memories_all.extend(memories)
            logger.info(f"🧠 [Memory] Searched memories:\n{self._str_memories(memories_all)}\n")
            system_prompt = self._build_system_prompt(memories_all, base_prompt=base_prompt)
        else:
            system_prompt = self._build_system_prompt(base_prompt=base_prompt)
        current_messages = [
            {"role": "system", "content": system_prompt},
            *chat_history.chat_history,
            {"role": "user", "content": query},
        ]
        past_key_values = None

        if self.config.enable_activation_memory:
            assert self.config.chat_model.backend == "huggingface", (
                "Activation memory only used for huggingface backend."
            )
            # TODO this only one cubes
            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube_id not in user_cube_ids:
                    continue
                if mem_cube.act_mem:
                    kv_cache = next(iter(mem_cube.act_mem.get_all()), None)
                    past_key_values = (
                        kv_cache.memory if (kv_cache and hasattr(kv_cache, "memory")) else None
                    )
                    break
            # Generate response
            response = self.chat_llm.generate(current_messages, past_key_values=past_key_values)
        else:
            response = self.chat_llm.generate(current_messages)
        logger.info(f"🤖 [Assistant] {response}\n")
        chat_history.chat_history.append({"role": "user", "content": query})
        chat_history.chat_history.append({"role": "assistant", "content": response})
        self.chat_history_manager[user_id] = chat_history

        # submit message to scheduler
        for accessible_mem_cube in accessible_cubes:
            mem_cube_id = accessible_mem_cube.cube_id
            mem_cube = self.mem_cubes[mem_cube_id]
            if self.enable_mem_scheduler and self.mem_scheduler is not None:
                message_item = ScheduleMessageItem(
                    user_id=target_user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    label=ANSWER_LABEL,
                    content=response,
                    timestamp=datetime.utcnow(),
                )
                self.mem_scheduler.submit_messages(messages=[message_item])

        return response

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
        elif memories:
            # For backward compatibility, append memories if no placeholder is found
            memory_context_with_header = "\n\n## Memories:\n" + memory_context
            return base_prompt + memory_context_with_header
        return base_prompt

    def _str_memories(
        self, memories: list[TextualMemoryItem], mode: Literal["concise", "full"] = "full"
    ) -> str:
        """Format memories for display."""
        if not memories:
            return "No memories."
        if mode == "concise":
            return "\n".join(f"{i + 1}. {memory.memory}" for i, memory in enumerate(memories))
        elif mode == "full":
            return "\n".join(f"{i + 1}. {memory}" for i, memory in enumerate(memories))

    def clear_messages(self, user_id: str | None = None) -> None:
        """Clear chat history."""
        user_id = user_id if user_id is not None else self.user_id
        self._register_chat_history(user_id)

    def create_user(
        self, user_id: str, role: UserRole = UserRole.USER, user_name: str | None = None
    ) -> str:
        """Create a new user.

        Args:
            user_name (str): Name of the user.
            role (UserRole): Role of the user.
            user_id (str, optional): Custom user ID.

        Returns:
            str: The created user ID.
        """
        if not user_name:
            user_name = user_id
        return self.user_manager.create_user(user_name, role, user_id)

    def list_users(self) -> list:
        """List all active users.

        Returns:
            list: List of user information dictionaries.
        """
        users = self.user_manager.list_users()
        return [
            {
                "user_id": user.user_id,
                "user_name": user.user_name,
                "role": user.role.value,
                "created_at": user.created_at.isoformat(),
                "is_active": user.is_active,
            }
            for user in users
        ]

    def create_cube_for_user(
        self,
        cube_name: str,
        owner_id: str,
        cube_path: str | None = None,
        cube_id: str | None = None,
    ) -> str:
        """Create a new cube for the current user.

        Args:
            cube_name (str): Name of the cube.
            cube_path (str, optional): Path to the cube.
            cube_id (str, optional): Custom cube ID.

        Returns:
            str: The created cube ID.
        """
        return self.user_manager.create_cube(cube_name, owner_id, cube_path, cube_id)

    def register_mem_cube(
        self,
        mem_cube_name_or_path: str | GeneralMemCube,
        mem_cube_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        """
        Register a MemCube with the MOS.

        Args:
            mem_cube_name_or_path (str): The name or path of the MemCube to register.
            mem_cube_id (str, optional): The identifier for the MemCube. If not provided, a default ID is used.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        self._validate_user_exists(target_user_id)

        if mem_cube_id is None:
            if isinstance(mem_cube_name_or_path, GeneralMemCube):
                mem_cube_id = f"cube_{target_user_id}"
            else:
                mem_cube_id = mem_cube_name_or_path

        if mem_cube_id in self.mem_cubes:
            logger.info(f"MemCube with ID {mem_cube_id} already in MOS, skip install.")
        else:
            if isinstance(mem_cube_name_or_path, GeneralMemCube):
                self.mem_cubes[mem_cube_id] = mem_cube_name_or_path
                logger.info(f"register new cube {mem_cube_id} for user {target_user_id}")
            elif os.path.exists(mem_cube_name_or_path):
                mem_cube_obj = GeneralMemCube.init_from_dir(mem_cube_name_or_path)
                self.mem_cubes[mem_cube_id] = mem_cube_obj
            else:
                logger.warning(
                    f"MemCube {mem_cube_name_or_path} does not exist, try to init from remote repo."
                )
                mem_cube_obj = GeneralMemCube.init_from_remote_repo(mem_cube_name_or_path)
                self.mem_cubes[mem_cube_id] = mem_cube_obj
        # Check if cube already exists in database
        existing_cube = self.user_manager.get_cube(mem_cube_id)

        # check the embedder is it consistent with MOSConfig
        if self.config.mem_reader.config.embedder != (
            cube_embedder := self.mem_cubes[mem_cube_id].text_mem.config.embedder
        ):
            logger.warning(
                f"Cube Embedder is not consistent with MOSConfig for cube: {mem_cube_id}, will use Cube Embedder: {cube_embedder}"
            )

        if existing_cube:
            # Cube exists, just add user to cube if not already associated
            if not self.user_manager.validate_user_cube_access(target_user_id, mem_cube_id):
                success = self.user_manager.add_user_to_cube(target_user_id, mem_cube_id)
                if success:
                    logger.info(f"User {target_user_id} added to existing cube {mem_cube_id}")
                else:
                    logger.error(f"Failed to add user {target_user_id} to cube {mem_cube_id}")
            else:
                logger.info(f"User {target_user_id} already has access to cube {mem_cube_id}")
        else:
            # Cube doesn't exist, create it
            self.create_cube_for_user(
                cube_name=mem_cube_name_or_path
                if not isinstance(mem_cube_name_or_path, GeneralMemCube)
                else mem_cube_id,
                owner_id=target_user_id,
                cube_id=mem_cube_id,
                cube_path=mem_cube_name_or_path
                if not isinstance(mem_cube_name_or_path, GeneralMemCube)
                else "init",
            )
            logger.info(f"register new cube {mem_cube_id} for user {target_user_id}")

    def unregister_mem_cube(self, mem_cube_id: str, user_id: str | None = None) -> None:
        """
        Unregister a MemCube by its identifier.

        Args:
            mem_cube_id (str): The identifier of the MemCube to unregister.
        """
        if mem_cube_id in self.mem_cubes:
            del self.mem_cubes[mem_cube_id]
        else:
            raise ValueError(f"MemCube with ID {mem_cube_id} does not exist.")

    def search(
        self,
        query: str,
        user_id: str | None = None,
        install_cube_ids: list[str] | None = None,
        top_k: int | None = None,
        mode: Literal["fast", "fine"] = "fast",
        internet_search: bool = False,
        moscube: bool = False,
        session_id: str | None = None,
        **kwargs,
    ) -> MOSSearchResult:
        """
        Search for textual memories across all registered MemCubes.

        Args:
            query (str): The search query.
            user_id (str, optional): The identifier of the user to search for.
                If None, the default user is used.
            install_cube_ids (list[str], optional): The list of MemCube IDs to install.
                If None, all MemCube for the user is used.

        Returns:
            MemoryResult: A dictionary containing the search results.
        """
        target_session_id = session_id if session_id is not None else self.session_id
        target_user_id = user_id if user_id is not None else self.user_id

        self._validate_user_exists(target_user_id)
        # Get all cubes accessible by the target user
        accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
        user_cube_ids = [cube.cube_id for cube in accessible_cubes]

        logger.info(
            f"User {target_user_id} has access to {len(user_cube_ids)} cubes: {user_cube_ids}"
        )
        if target_user_id not in self.chat_history_manager:
            self._register_chat_history(target_user_id)
        chat_history = self.chat_history_manager[target_user_id]

        # Create search filter if session_id is provided
        search_filter = None
        if session_id is not None:
            search_filter = {"session_id": session_id}

        result: MOSSearchResult = {
            "text_mem": [],
            "act_mem": [],
            "para_mem": [],
        }
        if install_cube_ids is None:
            install_cube_ids = user_cube_ids
        # create exist dict in mem_cubes and avoid  one search slow
        tmp_mem_cubes = {}
        time_start_cube_get = time.time()
        for mem_cube_id in install_cube_ids:
            if mem_cube_id in self.mem_cubes:
                tmp_mem_cubes[mem_cube_id] = self.mem_cubes.get(mem_cube_id)
        logger.info(
            f"time search: transform cube time user_id: {target_user_id} time is: {time.time() - time_start_cube_get}"
        )

        for mem_cube_id, mem_cube in tmp_mem_cubes.items():
            if (
                (mem_cube_id in install_cube_ids)
                and (mem_cube.text_mem is not None)
                and self.config.enable_textual_memory
            ):
                time_start = time.time()
                memories = mem_cube.text_mem.search(
                    query,
                    top_k=top_k if top_k else self.config.top_k,
                    mode=mode,
                    manual_close_internet=not internet_search,
                    info={
                        "user_id": target_user_id,
                        "session_id": target_session_id,
                        "chat_history": chat_history.chat_history,
                    },
                    moscube=moscube,
                    search_filter=search_filter,
                )
                result["text_mem"].append({"cube_id": mem_cube_id, "memories": memories})
                logger.info(
                    f"🧠 [Memory] Searched memories from {mem_cube_id}:\n{self._str_memories(memories)}\n"
                )
                search_time_end = time.time()
                logger.info(
                    f"time search graph: search graph time user_id: {target_user_id} time is: {search_time_end - time_start}"
                )
        return result

    def add(
        self,
        messages: MessageList | None = None,
        memory_content: str | None = None,
        doc_path: str | None = None,
        mem_cube_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        **kwargs,
    ) -> None:
        """
        Add textual memories to a MemCube.

        Args:
            messages (Union[MessageList, str]): The path to a document or a list of messages.
            memory_content (str, optional): The content of the memory to add.
            doc_path (str, optional): The path to the document associated with the memory.
            mem_cube_id (str, optional): The identifier of the MemCube to add the memories to.
                If None, the default MemCube for the user is used.
            user_id (str, optional): The identifier of the user to add the memories to.
                If None, the default user is used.
            session_id (str, optional): session_id
        """
        # user input messages
        assert (messages is not None) or (memory_content is not None) or (doc_path is not None), (
            "messages_or_doc_path or memory_content or doc_path must be provided."
        )
        # TODO: asure that session_id is a valid string
        time_start = time.time()

        target_session_id = session_id if session_id else self.session_id
        target_user_id = user_id if user_id is not None else self.user_id
        if mem_cube_id is None:
            # Try to find a default cube for the user
            accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
            if not accessible_cubes:
                raise ValueError(
                    f"No accessible cubes found for user '{target_user_id}'. Please register a cube first."
                )
            mem_cube_id = accessible_cubes[0].cube_id  # TODO not only first
        else:
            self._validate_cube_access(target_user_id, mem_cube_id)
        logger.info(
            f"time add: get mem_cube_id time user_id: {target_user_id} time is: {time.time() - time_start}"
        )

        time_start_0 = time.time()
        if mem_cube_id not in self.mem_cubes:
            raise ValueError(f"MemCube '{mem_cube_id}' is not loaded. Please register.")
        logger.info(
            f"time add: get mem_cube_id check in mem_cubes time user_id: {target_user_id} time is: {time.time() - time_start_0}"
        )
        time_start_1 = time.time()
        if (
            (messages is not None)
            and self.config.enable_textual_memory
            and self.mem_cubes[mem_cube_id].text_mem
        ):
            logger.info(
                f"time add: messages is not None and enable_textual_memory and text_mem is not None time user_id: {target_user_id} time is: {time.time() - time_start_1}"
            )
            if self.mem_cubes[mem_cube_id].config.text_mem.backend != "tree_text":
                add_memory = []
                metadata = TextualMemoryMetadata(
                    user_id=target_user_id, session_id=target_session_id, source="conversation"
                )
                for message in messages:
                    add_memory.append(
                        TextualMemoryItem(memory=message["content"], metadata=metadata)
                    )
                self.mem_cubes[mem_cube_id].text_mem.add(add_memory)
            else:
                messages_list = [messages]
                time_start_2 = time.time()
                memories = self.mem_reader.get_memory(
                    messages_list,
                    type="chat",
                    info={"user_id": target_user_id, "session_id": target_session_id},
                )
                logger.info(
                    f"time add: get mem_reader time user_id: {target_user_id} time is: {time.time() - time_start_2}"
                )
                mem_ids = []
                for mem in memories:
                    mem_id_list: list[str] = self.mem_cubes[mem_cube_id].text_mem.add(mem)
                    mem_ids.extend(mem_id_list)
                    logger.info(
                        f"Added memory user {target_user_id} to memcube {mem_cube_id}: {mem_id_list}"
                    )

                # submit messages for scheduler
                if self.enable_mem_scheduler and self.mem_scheduler is not None:
                    mem_cube = self.mem_cubes[mem_cube_id]
                    message_item = ScheduleMessageItem(
                        user_id=target_user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=mem_cube,
                        label=ADD_LABEL,
                        content=json.dumps(mem_ids),
                        timestamp=datetime.utcnow(),
                    )
                    self.mem_scheduler.submit_messages(messages=[message_item])

        # user profile
        if (
            (memory_content is not None)
            and self.config.enable_textual_memory
            and self.mem_cubes[mem_cube_id].text_mem
        ):
            if self.mem_cubes[mem_cube_id].config.text_mem.backend != "tree_text":
                metadata = TextualMemoryMetadata(
                    user_id=target_user_id, session_id=target_session_id, source="conversation"
                )
                self.mem_cubes[mem_cube_id].text_mem.add(
                    [TextualMemoryItem(memory=memory_content, metadata=metadata)]
                )
            else:
                messages_list = [
                    [{"role": "user", "content": memory_content}]
                ]  # for only user-str input and convert message
                memories = self.mem_reader.get_memory(
                    messages_list,
                    type="chat",
                    info={"user_id": target_user_id, "session_id": target_session_id},
                )

                mem_ids = []
                for mem in memories:
                    mem_id_list: list[str] = self.mem_cubes[mem_cube_id].text_mem.add(mem)
                    logger.info(
                        f"Added memory user {target_user_id} to memcube {mem_cube_id}: {mem_id_list}"
                    )
                    mem_ids.extend(mem_id_list)

                # submit messages for scheduler
                if self.enable_mem_scheduler and self.mem_scheduler is not None:
                    mem_cube = self.mem_cubes[mem_cube_id]
                    message_item = ScheduleMessageItem(
                        user_id=target_user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=mem_cube,
                        label=ADD_LABEL,
                        content=json.dumps(mem_ids),
                        timestamp=datetime.utcnow(),
                    )
                    self.mem_scheduler.submit_messages(messages=[message_item])

        # user doc input
        if (
            (doc_path is not None)
            and self.config.enable_textual_memory
            and self.mem_cubes[mem_cube_id].text_mem
        ):
            documents = self._get_all_documents(doc_path)
            doc_memories = self.mem_reader.get_memory(
                documents,
                type="doc",
                info={"user_id": target_user_id, "session_id": target_session_id},
            )

            mem_ids = []
            for mem in doc_memories:
                mem_id_list: list[str] = self.mem_cubes[mem_cube_id].text_mem.add(mem)
                mem_ids.extend(mem_id_list)

            # submit messages for scheduler
            if self.enable_mem_scheduler and self.mem_scheduler is not None:
                mem_cube = self.mem_cubes[mem_cube_id]
                message_item = ScheduleMessageItem(
                    user_id=target_user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    label=ADD_LABEL,
                    content=json.dumps(mem_ids),
                    timestamp=datetime.utcnow(),
                )
                self.mem_scheduler.submit_messages(messages=[message_item])

        logger.info(f"Add memory to {mem_cube_id} successfully")

    def get(
        self, mem_cube_id: str, memory_id: str, user_id: str | None = None
    ) -> TextualMemoryItem | ActivationMemoryItem | ParametricMemoryItem:
        """
        Get a textual memory from a MemCube.

        Args:
            mem_cube_id (str): The identifier of the MemCube to get the memory from.
            memory_id (str): The identifier of the  memory to get.
            user_id (str, optional): The identifier of the user to get the memory from.
                If None, the default user is used.

        Returns:
            Union[TextualMemoryItem, ActivationMemoryItem, ParametricMemoryItem]: The requested memory item.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        # Validate user has access to this cube
        self._validate_cube_access(target_user_id, mem_cube_id)
        if mem_cube_id is None:
            # Try to find a default cube for the user
            accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
            if not accessible_cubes:
                raise ValueError(
                    f"No accessible cubes found for user '{target_user_id}'. Please register a cube first."
                )
            mem_cube_id = accessible_cubes[0].cube_id  # TODO not only first
        else:
            self._validate_cube_access(target_user_id, mem_cube_id)

        assert mem_cube_id in self.mem_cubes, (
            f"MemCube with ID {mem_cube_id} does not exist. please regiester"
        )
        return self.mem_cubes[mem_cube_id].text_mem.get(memory_id)

    def get_all(
        self, mem_cube_id: str | None = None, user_id: str | None = None
    ) -> MOSSearchResult:
        """
        Get all textual memories from a MemCube.

        Args:
            mem_cube_id (str, optional): The identifier of the MemCube to get the memories from.
                If None, all MemCube for the user is used.
            user_id (str, optional): The identifier of the user to get the memories from.
                If None, the default user is used.

        Returns:
            MemoryResult: A dictionary containing the search results.
        """
        result: MOSSearchResult = {"para_mem": [], "act_mem": [], "text_mem": []}
        target_user_id = user_id if user_id is not None else self.user_id
        # Validate user has access to this cube
        if mem_cube_id is None:
            # Try to find a default cube for the user
            accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
            if not accessible_cubes:
                raise ValueError(
                    f"No accessible cubes found for user '{target_user_id}'. Please register a cube first."
                )
            mem_cube_id = accessible_cubes[0].cube_id  # TODO not only first
        else:
            self._validate_cube_access(target_user_id, mem_cube_id)
        if self.config.enable_textual_memory and self.mem_cubes[mem_cube_id].text_mem:
            result["text_mem"].append(
                {"cube_id": mem_cube_id, "memories": self.mem_cubes[mem_cube_id].text_mem.get_all()}
            )
        if self.config.enable_activation_memory and self.mem_cubes[mem_cube_id].act_mem:
            result["act_mem"].append(
                {"cube_id": mem_cube_id, "memories": self.mem_cubes[mem_cube_id].act_mem.get_all()}
            )
        return result

    def update(
        self,
        mem_cube_id: str,
        memory_id: str,
        text_memory_item: TextualMemoryItem | dict[str, Any],
        user_id: str | None = None,
    ) -> None:
        """
        Update a textual memory in a MemCube by text_memory_id and text_memory_id.

        Args:
            mem_cube_id (str): The identifier of the MemCube to update the memory in.
            memory_id (str): The identifier of the textual memory to update.
            text_memory_item (TextualMemoryItem | dict[str, Any]): The updated textual memory item.
        """
        assert mem_cube_id in self.mem_cubes, (
            f"MemCube with ID {mem_cube_id} does not exist. please regiester"
        )
        target_user_id = user_id if user_id is not None else self.user_id
        # Validate user has access to this cube
        self._validate_cube_access(target_user_id, mem_cube_id)
        if mem_cube_id is None:
            # Try to find a default cube for the user
            accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
            if not accessible_cubes:
                raise ValueError(
                    f"No accessible cubes found for user '{target_user_id}'. Please register a cube first."
                )
            mem_cube_id = accessible_cubes[0].cube_id  # TODO not only first
        else:
            self._validate_cube_access(target_user_id, mem_cube_id)
        if self.mem_cubes[mem_cube_id].config.text_mem.backend != "tree_text":
            self.mem_cubes[mem_cube_id].text_mem.update(memory_id, memories=text_memory_item)
            logger.info(f"MemCube {mem_cube_id} updated memory {memory_id}")
        else:
            logger.warning(
                f" {self.mem_cubes[mem_cube_id].config.text_mem.backend} does not support update memory"
            )

    def delete(self, mem_cube_id: str, memory_id: str, user_id: str | None = None) -> None:
        """
        Delete a textual memory from a MemCube by memory_id.

        Args:
            mem_cube_id (str): The identifier of the MemCube to delete the memory from.
            memory_id (str): The identifier of the  memory to delete.
        """
        assert mem_cube_id in self.mem_cubes, (
            f"MemCube with ID {mem_cube_id} does not exist. please regiester"
        )
        target_user_id = user_id if user_id is not None else self.user_id
        # Validate user has access to this cube
        self._validate_cube_access(target_user_id, mem_cube_id)
        if mem_cube_id is None:
            # Try to find a default cube for the user
            accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
            if not accessible_cubes:
                raise ValueError(
                    f"No accessible cubes found for user '{target_user_id}'. Please register a cube first."
                )
            mem_cube_id = accessible_cubes[0].cube_id  # TODO not only first
        else:
            self._validate_cube_access(target_user_id, mem_cube_id)
        self.mem_cubes[mem_cube_id].text_mem.delete(memory_id)
        logger.info(f"MemCube {mem_cube_id} deleted memory {memory_id}")

    def delete_all(self, mem_cube_id: str | None = None, user_id: str | None = None) -> None:
        """
        Delete all textual memories from a MemCube for user.

        Args:
            mem_cube_id (str): The identifier of the MemCube to delete the memories from.
        """
        assert mem_cube_id in self.mem_cubes, (
            f"MemCube with ID {mem_cube_id} does not exist. please regiester"
        )
        target_user_id = user_id if user_id is not None else self.user_id
        # Validate user has access to this cube
        self._validate_cube_access(target_user_id, mem_cube_id)
        if mem_cube_id is None:
            # Try to find a default cube for the user
            accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
            if not accessible_cubes:
                raise ValueError(
                    f"No accessible cubes found for user '{target_user_id}'. Please register a cube first."
                )
            mem_cube_id = accessible_cubes[0].cube_id  # TODO not only first
        else:
            self._validate_cube_access(target_user_id, mem_cube_id)
        self.mem_cubes[mem_cube_id].text_mem.delete_all()
        logger.info(f"MemCube {mem_cube_id} deleted all memories")

    def dump(
        self, dump_dir: str, user_id: str | None = None, mem_cube_id: str | None = None
    ) -> None:
        """Dump the MemCube to a dictionary.
        Args:
            dump_dir (str): The directory to dump the MemCube to.
            user_id (str, optional): The identifier of the user to dump the MemCube from.
                If None, the default user is used.
            mem_cube_id (str, optional): The identifier of the MemCube to dump.
                If None, the default MemCube for the user is used.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
        if not mem_cube_id:
            mem_cube_id = accessible_cubes[0].cube_id
        if mem_cube_id not in self.mem_cubes:
            raise ValueError(f"MemCube with ID {mem_cube_id} does not exist. please regiester")
        self.mem_cubes[mem_cube_id].dump(dump_dir)
        logger.info(f"MemCube {mem_cube_id} dumped to {dump_dir}")

    def load(
        self,
        load_dir: str,
        user_id: str | None = None,
        mem_cube_id: str | None = None,
        memory_types: list[Literal["text_mem", "act_mem", "para_mem"]] | None = None,
    ) -> None:
        """Dump the MemCube to a dictionary.
        Args:
            load_dir (str): The directory to load the MemCube from.
            user_id (str, optional): The identifier of the user to load the MemCube from.
                If None, the default user is used.
            mem_cube_id (str, optional): The identifier of the MemCube to load.
                If None, the default MemCube for the user is used.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
        if not mem_cube_id:
            mem_cube_id = accessible_cubes[0].cube_id
        if mem_cube_id not in self.mem_cubes:
            raise ValueError(f"MemCube with ID {mem_cube_id} does not exist. please regiester")
        self.mem_cubes[mem_cube_id].load(load_dir, memory_types=memory_types)
        logger.info(f"MemCube {mem_cube_id} loaded from {load_dir}")

    def get_user_info(self) -> dict[str, Any]:
        """Get current user information including accessible cubes.
        TODO: maybe input user_id
        Returns:
            dict: User information and accessible cubes.
        """
        user = self.user_manager.get_user(self.user_id)
        if not user:
            return {}

        accessible_cubes = self.user_manager.get_user_cubes(self.user_id)

        return {
            "user_id": user.user_id,
            "user_name": user.user_name,
            "role": user.role.value if hasattr(user.role, "value") else user.role,
            "created_at": user.created_at.isoformat(),
            "accessible_cubes": [
                {
                    "cube_id": cube.cube_id,
                    "cube_name": cube.cube_name,
                    "cube_path": cube.cube_path,
                    "owner_id": cube.owner_id,
                    "is_loaded": cube.cube_id in self.mem_cubes,
                }
                for cube in accessible_cubes
            ],
        }

    def share_cube_with_user(self, cube_id: str, target_user_id: str) -> bool:
        """Share a cube with another user.

        Args:
            cube_id (str): The cube ID to share.
            target_user_id (str): The user ID to share with.

        Returns:
            bool: True if successful, False otherwise.
        """
        # Validate current user has access to this cube
        self._validate_cube_access(cube_id, target_user_id)

        # Validate target user exists
        if not self.user_manager.validate_user(target_user_id):
            raise ValueError(f"Target user '{target_user_id}' does not exist or is inactive.")

        return self.user_manager.add_user_to_cube(target_user_id, cube_id)

    def get_query_rewrite(self, query: str, user_id: str | None = None):
        """
        Rewrite user's query according the context.
        Args:
            query (str): The search query that needs rewriting.
            user_id(str, optional): The identifier of the user that the query belongs to.
                If None, the default user is used.

        Returns:
            str: query after rewriting process.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        chat_history = self.chat_history_manager[target_user_id]

        dialogue = "————{}".format("\n————".join(chat_history.chat_history))
        user_prompt = QUERY_REWRITING_PROMPT.format(dialogue=dialogue, query=query)
        messages = {"role": "user", "content": user_prompt}
        rewritten_result = self.chat_llm.generate(messages=messages)
        rewritten_result = json.loads(rewritten_result)
        if rewritten_result.get("former_dialogue_related", False):
            rewritten_query = rewritten_result.get("rewritten_question")
            return rewritten_query if len(rewritten_query) > 0 else query
        return query
