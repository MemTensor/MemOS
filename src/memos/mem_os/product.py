import os
import time
import json
import uuid
import functools
from datetime import datetime
from collections import OrderedDict

from collections.abc import Generator
from typing import Literal, Callable, Any
from transformers import AutoTokenizer

from memos.mem_cube.general import GeneralMemCube
from memos.configs.mem_os import MOSConfig
from memos.log import get_logger
from memos.mem_os.core import MOSCore
from memos.mem_os.utils.format_utils import (
    convert_graph_to_tree_forworkmem,
    remove_embedding_recursive,
    filter_nodes_by_tree_ids,
    remove_embedding_from_memory_items,
    sort_children_by_memory_type,
)

from memos.memories.activation.item import ActivationMemoryItem
from memos.memories.parametric.item import ParametricMemoryItem
from memos.mem_user.persistent_user_manager import PersistentUserManager, UserRole
from memos.memories.textual.item import TextualMemoryMetadata, TreeNodeTextualMemoryMetadata, TextualMemoryItem
from memos.mem_scheduler.modules.schemas import ANSWER_LABEL, QUERY_LABEL, ScheduleMessageItem
from memos.types import MessageList


logger = get_logger(__name__)

CUBE_PATH = "/tmp/data"
MOCK_DATA=json.loads(open("./tmp/fake_data.json", "r").read())

def ensure_user_instance(max_instances: int = 100):
    """
    Decorator to ensure user instance exists before executing method.
    
    Args:
        max_instances (int): Maximum number of user instances to keep in memory.
                            When exceeded, least recently used instances are removed.
    """
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(self, *args, **kwargs):
            # Extract user_id from method signature
            user_id = None
            if user_id is None:
                user_id = kwargs.get('user_id')
            # Try to get user_id from positional arguments (first argument after self)
            if len(args) > 0 and (user_id is None):
                # Check if the first argument is user_id (string)
                if isinstance(args[0], str):
                    user_id = args[0]
                # Check if the second argument is user_id (for methods like chat(query, user_id))
                elif len(args) > 1 and isinstance(args[1], str):
                    user_id = args[1]
            if user_id is None:
                raise ValueError(f"user_id parameter not found in method {func.__name__}")
            
            # Ensure user instance exists
            self._ensure_user_instance(user_id, max_instances)
            
            # Call the original method
            return func(self, *args, **kwargs)
        
        return wrapper
    return decorator


class MOSProduct:
    """
    The MOSProduct class manages multiple users and their MOSCore instances.
    Each user has their own configuration and MOSCore instance.
    """

    def __init__(self, default_config: MOSConfig | None = None, max_user_instances: int = 100):
        """
        Initialize MOSProduct with an optional default configuration.

        Args:
            default_config (MOSConfig | None): Default configuration for new users
            max_user_instances (int): Maximum number of user instances to keep in memory
        """
        self.default_config = default_config
        # Use OrderedDict to maintain insertion order for LRU behavior
        self.user_instances: OrderedDict[str, MOSCore] = OrderedDict()
        self.user_configs: dict[str, MOSConfig] = {}
        self.max_user_instances = max_user_instances
        # Use PersistentUserManager instead of UserManager
        self.global_user_manager = PersistentUserManager(user_id="root")

        # Initialize tiktoken for streaming
        try:
            # Use gpt2 encoding which is more stable and widely compatible
            self.tokenizer = AutoTokenizer.from_pretrained("Qwen/Qwen3-0.6B")
            logger.info("tokenizer initialized successfully for streaming")
        except Exception as e:
            logger.warning(f"Failed to initialize tokenizer, will use character-based chunking: {e}")
            self.tokenizer = None

        # Initialize with default config if provided
        if default_config:
            self._create_user_instance(default_config.user_id, default_config)
        
        # Restore user instances from persistent storage (limited by max_instances)
        self._restore_user_instances()

    def _restore_user_instances(self) -> None:
        """Restore user instances from persistent storage after service restart."""
        try:
            # Get all user configurations from persistent storage
            user_configs = self.global_user_manager.list_user_configs()
            
            # Get the raw database records for sorting by updated_at
            session = self.global_user_manager._get_session()
            try:
                from memos.mem_user.persistent_user_manager import UserConfig
                db_configs = session.query(UserConfig).all()
                # Create a mapping of user_id to updated_at timestamp
                updated_at_map = {config.user_id: config.updated_at for config in db_configs}
                
                # Sort by updated_at timestamp (most recent first) and limit by max_instances
                sorted_configs = sorted(
                    user_configs.items(),
                    key=lambda x: updated_at_map.get(x[0], ''),
                    reverse=True
                )[:self.max_user_instances]
            finally:
                session.close()
            
            for user_id, config in sorted_configs:
                if user_id not in self.user_instances:
                    try:
                        # Create MOSCore instance with restored config
                        mos_instance = self._create_user_instance(user_id, config)
                        logger.info(f"Restored user instance for {user_id}")
                        
                        # Load user cubes
                        self._load_user_cubes(user_id)
                        
                    except Exception as e:
                        logger.error(f"Failed to restore user instance for {user_id}: {e}")
                        
        except Exception as e:
            logger.error(f"Error during user instance restoration: {e}")

    def _ensure_user_instance(self, user_id: str, max_instances: int = None) -> None:
        """
        Ensure user instance exists, creating it if necessary.
        
        Args:
            user_id (str): The user ID
            max_instances (int): Maximum instances to keep in memory (overrides class default)
        """
        if user_id in self.user_instances:
            # Move to end (most recently used)
            self.user_instances.move_to_end(user_id)
            return
        
        # Try to get config from persistent storage first
        stored_config = self.global_user_manager.get_user_config(user_id)
        if stored_config:
            self._create_user_instance(user_id, stored_config)
        else:
            # Use default config
            if not self.default_config:
                raise ValueError(f"No configuration available for user {user_id}")
            self._create_user_instance(user_id, self.default_config)
        
        # Apply LRU eviction if needed
        max_instances = max_instances or self.max_user_instances
        if len(self.user_instances) > max_instances:
            # Remove least recently used instance
            oldest_user_id = next(iter(self.user_instances))
            del self.user_instances[oldest_user_id]
            logger.info(f"Removed least recently used user instance: {oldest_user_id}")

    def _create_user_instance(self, user_id: str, config: MOSConfig) -> MOSCore:
        """Create a new MOSCore instance for a user."""
        # Create a copy of config with the specific user_id
        user_config = config.model_copy(deep=True)
        user_config.user_id = user_id
        
        # Create MOSCore instance with the persistent user manager
        mos_instance = MOSCore(user_config, user_manager=self.global_user_manager)
        
        # Add to OrderedDict (most recently used)
        self.user_instances[user_id] = mos_instance
        self.user_configs[user_id] = user_config
        
        # Save configuration to persistent storage
        self.global_user_manager.save_user_config(user_id, user_config)
        
        return mos_instance

    def _get_or_create_user_instance(
        self, user_id: str, config: MOSConfig | None = None
    ) -> MOSCore:
        """Get existing user instance or create a new one."""
        if user_id in self.user_instances:
            return self.user_instances[user_id]

        # Try to get config from persistent storage first
        stored_config = self.global_user_manager.get_user_config(user_id)
        if stored_config:
            return self._create_user_instance(user_id, stored_config)

        # Use provided config or default config
        user_config = config or self.default_config
        if not user_config:
            raise ValueError(f"No configuration provided for user {user_id}")

        return self._create_user_instance(user_id, user_config)

    def _load_user_cubes(self, user_id: str) -> None:
        """Load all cubes for a user into memory."""
        if user_id not in self.user_instances:
            return

        mos_instance = self.user_instances[user_id]
        accessible_cubes = self.global_user_manager.get_user_cubes(user_id)

        for cube in accessible_cubes[:1]:
            if cube.cube_id not in mos_instance.mem_cubes:
                try:
                    if cube.cube_path and os.path.exists(cube.cube_path):
                        mos_instance.register_mem_cube(cube.cube_path, cube.cube_id, user_id)
                    else:
                        logger.warning(
                            f"Cube path {cube.cube_path} does not exist for cube {cube.cube_id}"
                        )
                except Exception as e:
                    logger.error(f"Failed to load cube {cube.cube_id} for user {user_id}: {e}")

    def _build_system_prompt(self, user_id: str, memories_all: list[TextualMemoryItem]) -> str:
        """
        Build custom system prompt for the user with memory references.
        
        Args:
            user_id (str): The user ID.
            memories (list[TextualMemoryItem]): The memories to build the system prompt.
            
        Returns:
            str: The custom system prompt.
        """
        
        # Build base prompt
        base_prompt = (
            "You are a knowledgeable and helpful AI assistant with access to user memories. "
            "When responding to user queries, you should reference relevant memories using the provided memory IDs. "
            "Use the reference format: [refid:memoriesID] "
            "where refid is a sequential number starting from 1 and increments for each reference in your response, "
            "and memoriesID is the specific memory ID provided in the available memories list. "
            "For example: [1:abc123], [2:def456], [3:ghi789]. "
            "Only reference memories that are directly relevant to the user's question. "
            "Make your responses natural and conversational while incorporating memory references when appropriate."
        )
        
        # Add memory context if available
        if memories_all:
            memory_context = "\n\n## Available ID Memories:\n"
            for i, memory in enumerate(memories_all, 1):
                # Format: [memory_id]: memory_content
                memory_id = f"{memory.id.split('-')[0]}" if hasattr(memory, 'id') else f"mem_{i}"
                memory_content = memory.memory if hasattr(memory, 'memory') else str(memory)
                memory_context += f"{memory_id}: {memory_content}\n"
            return base_prompt + memory_context
        
        return base_prompt

    def _process_streaming_references_complete(self, text_buffer: str) -> tuple[str, str]:
        """
        Complete streaming reference processing to ensure reference tags are never split.
        
        Args:
            text_buffer (str): The accumulated text buffer.
            
        Returns:
            tuple[str, str]: (processed_text, remaining_buffer)
        """
        import re
        
        # Pattern to match complete reference tags: [refid:memoriesID]
        complete_pattern = r'\[\d+:[^\]]+\]'
        
        # Find all complete reference tags
        complete_matches = list(re.finditer(complete_pattern, text_buffer))
        
        if complete_matches:
            # Find the last complete tag
            last_match = complete_matches[-1]
            end_pos = last_match.end()
            
            # Return text up to the end of the last complete tag
            processed_text = text_buffer[:end_pos]
            remaining_buffer = text_buffer[end_pos:]
            return processed_text, remaining_buffer
        
        # Check for incomplete reference tags
        # Look for opening bracket with number and colon
        opening_pattern = r'\[\d+:'
        opening_matches = list(re.finditer(opening_pattern, text_buffer))
        
        if opening_matches:
            # Find the last opening tag
            last_opening = opening_matches[-1]
            opening_start = last_opening.start()
            
            # Check if we have a complete opening pattern
            if last_opening.end() <= len(text_buffer):
                # We have a complete opening pattern, keep everything in buffer
                return "", text_buffer
            else:
                # Incomplete opening pattern, return text before it
                return text_buffer[:opening_start], text_buffer[opening_start:]
        
        # Check for partial opening pattern (starts with [ but not complete)
        if '[' in text_buffer:
            ref_start = text_buffer.find('[')
            return text_buffer[:ref_start], text_buffer[ref_start:]
        
        # No reference tags found, return all text
        return text_buffer, ""


    def _extract_references_from_response(self, response: str) -> list[dict]:
        """
        Extract reference information from the response.
        
        Args:
            response (str): The complete response text.
            
        Returns:
            list[dict]: List of reference information.
        """
        import re
        
        references = []
        # Pattern to match [refid:memoriesID]
        pattern = r'\[(\d+):([^\]]+)\]'
        
        matches = re.findall(pattern, response)
        for ref_number, memory_id in matches:
            references.append({
                "memory_id": memory_id,
                "reference_number": int(ref_number)
            })
        
        return references

    def _chunk_response_with_tiktoken(self, response: str, chunk_size: int = 5) -> Generator[str, None, None]:
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
            print(response)
            tokens = self.tokenizer.encode(response)
            
            for i in range(0, len(tokens), chunk_size):
                token_chunk = tokens[i:i + chunk_size]
                chunk_text = self.tokenizer.decode(token_chunk)
                yield chunk_text
        else:
            # Fallback to character-based chunking
            char_chunk_size = chunk_size * 4  # Approximate character to token ratio
            for i in range(0, len(response), char_chunk_size):
                yield response[i:i + char_chunk_size]
    def _send_message_to_scheduler(
            self, 
            user_id: str, 
            mem_cube_id: str, 
            query: str,
            label: str,
            mos_instance: MOSCore,
            ):
        """
        Send message to scheduler.
        args:
            user_id: str,
            mem_cube_id: str,
            query: str,
            mos_instance: MOSCore,
        """
        
        if mos_instance.enable_mem_scheduler and (mos_instance.mem_scheduler is not None):
            message_item = ScheduleMessageItem(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mos_instance.mem_cubes[mem_cube_id],
                label=label,
                content=query,
                timestamp=datetime.now(),
            )
            mos_instance.mem_scheduler.submit_messages(messages=[message_item])

    def user_register(
        self,
        user_id: str,
        user_name: str | None = None,
        config: MOSConfig | None = None,
        interests: str | None = None,
        default_mem_cube: GeneralMemCube | None = None,
    ) -> dict[str, str]:
        """Register a new user with configuration and default cube.

        Args:
            user_id (str): The user ID for registration.
            user_name (str): The user name for registration.
            config (MOSConfig | None, optional): User-specific configuration. Defaults to None.
            interests (str | None, optional): User interests as string. Defaults to None.

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
                user_name =  user_id
                
            # Create user with configuration using persistent user manager
            created_user_id = self.global_user_manager.create_user_with_config(
                user_id, user_config, UserRole.USER, user_id
            )

            # Create MOSCore instance for this user
            mos_instance = self._create_user_instance(user_id, user_config)

            # Create a default cube for the user
            default_cube_name = f"{user_name}_default_cube"
            mem_cube_name_or_path = f"{CUBE_PATH}/{default_cube_name}"
            default_cube_id = mos_instance.create_cube_for_user(
                cube_name=default_cube_name, 
                owner_id=user_id, 
                cube_path=mem_cube_name_or_path
            )

            if default_mem_cube:
                try:
                    default_mem_cube.dump(mem_cube_name_or_path)
                except Exception as e:
                    print(e)
            # Register the default cube with MOS
            mos_instance.register_mem_cube(mem_cube_name_or_path, default_cube_id, user_id)

            # Add interests to the default cube if provided
            if interests:
                mos_instance.add(
                    memory_content=interests, mem_cube_id=default_cube_id, user_id=user_id
                )

            # Load all cubes for this user
            self._load_user_cubes(user_id)

            return {
                "status": "success",
                "message": f"User {user_name} registered successfully with default cube {default_cube_id}",
                "user_id": user_id,
                "default_cube_id": default_cube_id,
            }

        except Exception as e:
            return {"status": "error", "message": f"Failed to register user: {e!s}"}

    @ensure_user_instance()
    def get_suggestion_query(self, user_id: str) -> list[str]:
        """Get suggestion query from LLM.
        Args:
            user_id (str): User ID.

        Returns:
            list[str]: The suggestion query list.
        """
        mos_instance = self.user_instances[user_id]
        suggestion_prompt = """
        You are a helpful assistant that can help users to generate suggestion query 
        I will get some user recently memories,
        you should generate some suggestion query  , the query should be user what to query,
        user recently memories is :
        {memories}
        please generate 3 suggestion query,
        output should be a json format, the key is "query", the value is a list of suggestion query.
        
        example:
        {{
            "query": ["query1", "query2", "query3"]
        }}
        """
        memories = "\n".join([m.memory for m in mos_instance.search("my recently memories",user_id=user_id, top_k=5)["text_mem"][0]["memories"]])
        message_list = [{"role": "system", "content": suggestion_prompt.format(memories=memories)}]
        response = mos_instance.chat_llm.generate(message_list)
        response_json = json.loads(response)
        return response_json["query"]

    @ensure_user_instance()
    def chat(
        self,
        query: str,
        user_id: str,
        cube_id: str | None = None,
        history: MessageList | None = None,
    ) -> Generator[str, None, None]:
        """Chat with LLM SSE Type.
        Args:
            query (str): Query string.
            user_id (str): User ID.
            cube_id (str, optional): Custom cube ID for user.
            history (list[dict], optional): Chat history.

        Returns:
            Generator[str, None, None]: The response string generator.
        """
        mos_instance = self.user_instances[user_id]

        # Load user cubes if not already loaded
        self._load_user_cubes(user_id)
        time_start = time.time()
        memories_list = mos_instance.search(query, user_id)["text_mem"]
        # Get response from MOSCore (returns string, not generator)
        response = mos_instance.chat(query, user_id)
        time_end = time.time()
        
        # Use tiktoken for proper token-based chunking
        for chunk in self._chunk_response_with_tiktoken(response, chunk_size=5):
            chunk_data = f"data: {json.dumps({'type': 'text', 'content': chunk})}\n\n"
            yield chunk_data
        yield f"data: {json.dumps({'type': 'reference', 'content': reference})}\n\n"
        total_time = round(float(time_end - time_start), 1)
        reference = []
        for memories in memories_list:
            memories_json = memories.model_dump()
            memories_json["metadata"]["ref_id"] = f'[{memories.id.split("-")[0]}]'
            memories_json["metadata"]["embedding"] = []
            memories_json["metadata"]["sources"] = []
            reference.append(memories_json)

        yield f"data: {json.dumps({'type': 'time', 'content': {'total_time': total_time, 'speed_improvement': '23%'}})}\n\n"
        yield f"data: {json.dumps({'type': 'end'})}\n\n"
        
    @ensure_user_instance()
    def chat_with_references(
        self,
        query: str,
        user_id: str,
        cube_id: str | None = None,
        history: MessageList | None = None,
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
        mos_instance = self.user_instances[user_id]
        self._load_user_cubes(user_id)
        
        time_start = time.time()
        memories_list = mos_instance.search(query, user_id)["text_mem"][0]["memories"]
        
        # Build custom system prompt with relevant memories
        system_prompt = self._build_system_prompt(user_id, memories_list)
        
        # Get chat history
        target_user_id = user_id if user_id is not None else mos_instance.user_id
        if target_user_id not in mos_instance.chat_history_manager:
            mos_instance._register_chat_history(target_user_id)
        
        chat_history = mos_instance.chat_history_manager[target_user_id]
        current_messages = [
            {"role": "system", "content": system_prompt},
            *chat_history.chat_history,
            {"role": "user", "content": query},
        ]
        
        # Generate response with custom prompt
        past_key_values = None
        if mos_instance.config.enable_activation_memory:
            # Handle activation memory (copy MOSCore logic)
            for mem_cube_id, mem_cube in mos_instance.mem_cubes.items():
                if mem_cube.act_mem:
                    kv_cache = next(iter(mem_cube.act_mem.get_all()), None)
                    past_key_values = (
                        kv_cache.memory if (kv_cache and hasattr(kv_cache, "memory")) else None
                    )
                    break
            response = mos_instance.chat_llm.generate(current_messages, past_key_values=past_key_values)
        else:
            response = mos_instance.chat_llm.generate(current_messages)
        
        time_end = time.time()
        
        # Simulate streaming output with proper reference handling using tiktoken
        
        # Initialize buffer for streaming
        buffer = ""
        
        # Use tiktoken for proper token-based chunking
        for chunk in self._chunk_response_with_tiktoken(response, chunk_size=5):
            buffer += chunk
            
            # Process buffer to ensure complete reference tags
            processed_chunk, remaining_buffer = self._process_streaming_references_complete(buffer)
            
            if processed_chunk:
                chunk_data = f"data: {json.dumps({'type': 'text', 'data': processed_chunk}, ensure_ascii=False)}\n\n"
                yield chunk_data
                buffer = remaining_buffer
        
        # Process any remaining buffer
        if buffer:
            processed_chunk, remaining_buffer = self._process_streaming_references_complete(buffer)
            if processed_chunk:
                chunk_data = f"data: {json.dumps({'type': 'text', 'data': processed_chunk}, ensure_ascii=False)}\n\n"
                yield chunk_data
        
        # Prepare reference data
        reference = []
        for memories in memories_list:
            memories_json = memories.model_dump()
            memories_json["metadata"]["ref_id"] = f'{memories.id.split("-")[0]}'
            memories_json["metadata"]["embedding"] = []
            memories_json["metadata"]["sources"] = []
            memories_json["metadata"]["memory"] = memories.memory
            reference.append({"metadata": memories_json["metadata"]})
        
        yield f"data: {json.dumps({'type': 'reference', 'data': reference})}\n\n"
        total_time = round(float(time_end - time_start), 1)
        yield f"data: {json.dumps({'type': 'time', 'data': {'total_time': total_time, 'speed_improvement': '23%'}})}\n\n"
        chat_history.chat_history.append({"role": "user", "content": query})
        chat_history.chat_history.append({"role": "assistant", "content": response})
        self._send_message_to_scheduler(user_id=user_id, 
                                        mem_cube_id=cube_id, 
                                        query=query, 
                                        label=QUERY_LABEL,
                                        mos_instance=mos_instance)
        self._send_message_to_scheduler(user_id=user_id, 
                                        mem_cube_id=cube_id, 
                                        query=response, 
                                        label=ANSWER_LABEL,
                                        mos_instance=mos_instance)
        mos_instance.chat_history_manager[user_id] = chat_history
        
        yield f"data: {json.dumps({'type': 'end'})}\n\n"
        

    @ensure_user_instance()
    def get_all(
        self,
        user_id: str,
        memory_type: Literal["text_mem", "act_mem", "param_mem"],
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
        mos_instance = self.user_instances[user_id]

        # Load user cubes if not already loaded
        self._load_user_cubes(user_id)
        memory_list = mos_instance.get_all(mem_cube_id=mem_cube_ids[0] if mem_cube_ids else None, user_id=user_id)[memory_type]
        reformat_memory_list = []
        if memory_type == "text_mem":
            for memory in memory_list:
                memories = remove_embedding_recursive(memory["memories"])
                custom_type_ratios = {
                    'WorkingMemory': 0.20,
                    'LongTermMemory': 0.40,
                    'UserMemory': 0.40
                }
                tree_result = convert_graph_to_tree_forworkmem(memories,target_node_count=150, type_ratios=custom_type_ratios)
                memories_filtered = filter_nodes_by_tree_ids(tree_result, memories)
                children = tree_result["children"]
                children_sort = sort_children_by_memory_type(children)
                tree_result["children"] = children_sort
                memories_filtered["tree_structure"] = tree_result
                reformat_memory_list.append({"cube_id": memory["cube_id"], "memories": [memories_filtered]})
        elif memory_type == "act_mem":
            reformat_memory_list.append({"cube_id": "xxxxxxxxxxxxxxxx" if not mem_cube_ids else mem_cube_ids[0], "memories": MOCK_DATA})
        return reformat_memory_list
    
    def _get_subgraph(
        self,
        query: str,
        mem_cube_id: str,
        user_id: str | None = None, 
        top_k: int = 5,
        mos_instance: MOSCore | None = None
    ) -> list[dict[str, Any]]:
        result = {"para_mem": [], "act_mem": [], "text_mem": []}
        if mos_instance.config.enable_textual_memory and mos_instance.mem_cubes[mem_cube_id].text_mem:
            result["text_mem"].append(
                {"cube_id": mem_cube_id, "memories": mos_instance.mem_cubes[mem_cube_id].text_mem.get_relevant_subgraph(query, top_k=top_k)}
            )
        return result

    @ensure_user_instance()
    def get_subgraph(
        self,
        user_id: str,
        query: str,
        mem_cube_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Get all memory items for a user.

        Args:
            user_id (str): The ID of the user.
            cube_id (str | None, optional): The ID of the cube. Defaults to None.
            mem_cube_ids (list[str], optional): The IDs of the cubes. Defaults to None.

        Returns:
            list[dict[str, Any]]: A list of memory items with cube_id and memories structure.
        """
        mos_instance = self.user_instances[user_id]
        # Load user cubes if not already loaded
        self._load_user_cubes(user_id)
        memory_list = self._get_subgraph(query=query, 
                                         mem_cube_id=mem_cube_ids[0], 
                                         user_id=user_id, 
                                         top_k=20,
                                         mos_instance=mos_instance)["text_mem"]
        reformat_memory_list = []
        for memory in memory_list:
            memories = remove_embedding_recursive(memory["memories"])
            custom_type_ratios = {
                'WorkingMemory': 0.20,
                'LongTermMemory': 0.40,
                'UserMemory': 0.4
            }
            tree_result = convert_graph_to_tree_forworkmem(memories,target_node_count=150, type_ratios=custom_type_ratios)
            memories_filtered = filter_nodes_by_tree_ids(tree_result, memories)
            children = tree_result["children"]
            children_sort = sort_children_by_memory_type(children)
            tree_result["children"] = children_sort
            memories_filtered["tree_structure"] = tree_result
            reformat_memory_list.append({"cube_id": memory["cube_id"], "memories": [memories_filtered]})
        return reformat_memory_list

    @ensure_user_instance()
    def search(self, query: str, user_id: str, install_cube_ids: list[str] | None = None):
        """Search memories for a specific user."""
        mos_instance = self.user_instances[user_id]

        # Load user cubes if not already loaded

        self._load_user_cubes(user_id)
        search_result = mos_instance.search(query, user_id, install_cube_ids)
        text_memory_list = search_result["text_mem"]
        reformat_memory_list = []
        for memory in text_memory_list:
            memories_list = []
            for data in memory["memories"]:
                memories = data.model_dump()
                # memories = remove_embedding_from_memory_items(memory["memories"])
                memories["ref_id"] = f'[{memories["id"].split("-")[0]}]'
                memories["metadata"]["embedding"] = []
                memories["metadata"]["sources"] = []
                memories["metadata"]["ref_id"] = f'[{memories["id"].split("-")[0]}]'
                memories["metadata"]["id"] = memories["id"]
                memories["metadata"]["memory"] = memories["memory"]
                memories_list.append(memories)
            reformat_memory_list.append({"cube_id": memory["cube_id"], "memories": memories_list})
        search_result["text_mem"] = reformat_memory_list
        return search_result

    @ensure_user_instance()
    def add(
        self,
        user_id: str,
        messages: MessageList | None = None,
        memory_content: str | None = None,
        doc_path: str | None = None,
        mem_cube_id: str | None = None,
    ):
        """Add memory for a specific user."""
        mos_instance = self.user_instances[user_id]

        # Load user cubes if not already loaded
        self._load_user_cubes(user_id)

        return mos_instance.add(messages, memory_content, doc_path, mem_cube_id, user_id)

    def list_users(self) -> list:
        """List all registered users."""
        return self.global_user_manager.list_users()

    @ensure_user_instance()
    def get_user_info(self, user_id: str) -> dict:
        """Get user information including accessible cubes."""
        mos_instance = self.user_instances[user_id]
        return mos_instance.get_user_info()

    @ensure_user_instance()
    def share_cube_with_user(self, cube_id: str, owner_user_id: str, target_user_id: str) -> bool:
        """Share a cube with another user."""
        mos_instance = self.user_instances[owner_user_id]
        return mos_instance.share_cube_with_user(cube_id, target_user_id)

    @ensure_user_instance()
    def clear_user_chat_history(self, user_id: str) -> None:
        """Clear chat history for a specific user."""
        mos_instance = self.user_instances[user_id]
        mos_instance.clear_messages(user_id)

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
            success = self.global_user_manager.save_user_config(user_id, config)
            if success:
                # Update in-memory config
                self.user_configs[user_id] = config
                
                # Recreate MOSCore instance with new config if user is active
                if user_id in self.user_instances:
                    mos_instance = self._create_user_instance(user_id, config)
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
        return self.global_user_manager.get_user_config(user_id)

    def get_active_user_count(self) -> int:
        """Get the number of active user instances in memory."""
        return len(self.user_instances)

    def get_user_instance_info(self) -> dict[str, Any]:
        """Get information about user instances in memory."""
        return {
            "active_instances": len(self.user_instances),
            "max_instances": self.max_user_instances,
            "user_ids": list(self.user_instances.keys()),
            "lru_order": list(self.user_instances.keys())  # OrderedDict maintains insertion order
        }