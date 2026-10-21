import os

from typing import Literal

from memos.configs.mem_chat import SimpleMemChatConfig
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_chat.base import BaseMemChat
from memos.mem_cube.base import BaseMemCube
from memos.memories.activation.kv import move_dynamic_cache_htod
from memos.memories.textual.item import TextualMemoryItem
from memos.types import ChatHistory, MessageList


logger = get_logger(__name__)


class SimpleMemChat(BaseMemChat):
    """Simple MemChat class."""

    def __init__(self, config: SimpleMemChatConfig):
        """Initialize the MemChat with the given configuration."""
        self.config = config
        self.chat_llm = LLMFactory.from_config(config.chat_llm)
        self._mem_cube = None

    @property
    def mem_cube(self) -> BaseMemCube:
        """The memory cube associated with this MemChat."""
        return self._mem_cube

    @mem_cube.setter
    def mem_cube(self, value: BaseMemCube) -> None:
        """The memory cube associated with this MemChat."""
        self._mem_cube = value

    def run(self) -> None:
        """Run the MemChat."""

        # Start MemChat

        print(
            "\n📢 [System] " + "Simple MemChat is running.\n"
            "Commands: 'bye' to quit, 'clear' to clear chat history, 'mem' to show all memories, 'export' to export chat history\n",
        )

        messages = []
        while True:
            # Get user input

            user_input = input("👤 [You] ").strip()
            print()

            if user_input.lower() == "bye":
                break
            elif user_input.lower() == "clear":
                messages = []
                print("📢 [System] Chat history cleared.")
                continue
            elif user_input.lower() == "mem":
                if self.config.enable_textual_memory:
                    all_memories = self.mem_cube.text_mem.get_all()
                    print(f"🧠 [Memory] \n{self._str_memories(all_memories)}\n")
                else:
                    print("📢 [System] Textual memory is not enabled.\n")
                continue
            elif user_input.lower() == "export":
                if messages:
                    filepath = self._export_chat_history(messages)
                    print(f"📢 [System] Chat history exported to: {filepath}\n")
                else:
                    print("📢 [System] No chat history to export.\n")
                continue
            elif user_input == "":
                continue

            # Get memories

            if self.config.enable_textual_memory:
                memories = self.mem_cube.text_mem.search(user_input, top_k=self.config.top_k)
                print(
                    f"🧠 [Memory] Searched memories:\n{self._str_memories(memories, mode='concise')}\n"
                )
                stable_system = self._build_stable_system_prompt()
                dynamic_ctx = self._build_dynamic_memory_context(memories)
            else:
                stable_system = self._build_stable_system_prompt()
                dynamic_ctx = None
            # Issue #2524: stable system first, then history, then dynamic
            # context, then current user turn — keeps the chat history inside
            # the provider's shared prefix.
            current_messages: list[dict] = [{"role": "system", "content": stable_system}]
            current_messages.extend(messages)
            if dynamic_ctx:
                current_messages.append({"role": "system", "content": dynamic_ctx})
            current_messages.append({"role": "user", "content": user_input})

            if self.config.enable_activation_memory:
                past_key_values = None
                loaded_kv_cache_item = next(
                    iter(self.mem_cube.act_mem.kv_cache_memories.values()), None
                )
                if loaded_kv_cache_item is not None:
                    # If has loaded kv cache, we move it to device before inferring.
                    # Currently, we move only single kv cache item
                    past_key_values = loaded_kv_cache_item
                    past_key_values.kv_cache = move_dynamic_cache_htod(
                        past_key_values.kv_cache, self.chat_llm.model.device
                    )

                # Generate response
                response = self.chat_llm.generate(
                    current_messages,
                    past_key_values=past_key_values.kv_cache if past_key_values else None,
                )
            else:
                # Generate response without activation memory
                response = self.chat_llm.generate(current_messages)

            print(f"🤖 [Assistant] {response}\n")
            messages.append({"role": "user", "content": user_input})
            messages.append({"role": "assistant", "content": response})
            messages = messages[
                -self.config.max_turns_window :
            ]  # Keep only recent messages to avoid context overflow

            # Extract memories

            if self.config.enable_textual_memory:
                new_memories = self.mem_cube.text_mem.extract(messages[-2:])
                for memory in new_memories:
                    memory.metadata.user_id = self.config.user_id
                    memory.metadata.session_id = self.config.session_id
                    memory.metadata.status = "activated"
                self.mem_cube.text_mem.add(new_memories)
                print(
                    f"🧠 [Memory] Stored {len(new_memories)} new memory(ies):\n"
                    f"{self._str_memories(new_memories, 'concise')}\n"
                )

        # Stop MemChat

        print("📢 [System] MemChat has stopped.")

    def _build_system_prompt(self, memories: list | None = None) -> str:
        """Build system prompt with optional memories context."""
        base_prompt = (
            "You are a knowledgeable and helpful AI assistant. "
            "You have access to conversation memories that help you provide more personalized responses. "
            "Use the memories to understand the user's context, preferences, and past interactions. "
            "If memories are provided, reference them naturally when relevant, but don't explicitly mention having memories."
        )

        if memories:
            memory_context = "\n\n## Memories:\n"
            for i, memory in enumerate(memories, 1):
                memory_context += f"{i}. ({memory.metadata.memory_time}) {memory.memory}\n"
            return base_prompt + memory_context

        return base_prompt

    # Prefix-cache-friendly split (Issue #2524)
    def _build_stable_system_prompt(self) -> str:
        """Return the stable (cross-turn constant) system prompt."""
        return (
            "You are a knowledgeable and helpful AI assistant. "
            "You have access to conversation memories that help you provide more personalized responses. "
            "Use the memories to understand the user's context, preferences, and past interactions. "
            "If memories are provided, reference them naturally when relevant, but don't explicitly mention having memories."
        )

    def _build_dynamic_memory_context(self, memories: list | None) -> str | None:
        """Return a system message carrying this turn's retrieved memories.

        Returned string is intended to sit immediately before the latest
        user turn so the chat history that precedes it stays part of the
        provider's shared prefix.
        """
        if not memories:
            return None
        lines = ["## Memories"]
        for i, memory in enumerate(memories, 1):
            lines.append(f"{i}. ({memory.metadata.memory_time}) {memory.memory}")
        return "\n".join(lines)

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

    def _export_chat_history(self, messages: MessageList, output_dir: str = "chat_exports") -> str:
        """Export chat history to JSON file.

        Args:
            messages: List of chat messages
            output_dir: Directory to save the export file

        Returns:
            Path to the exported JSON file
        """
        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)

        # Generate filename with user_id and timestamp
        timestamp = self.config.created_at.strftime("%Y%m%d_%H%M%S")
        filename = f"{self.config.user_id}_{timestamp}_chat_history.json"
        filepath = os.path.join(output_dir, filename)

        # Prepare export data
        export_data = ChatHistory(
            user_id=self.config.user_id,
            session_id=self.config.session_id,
            created_at=self.config.created_at,
            total_messages=len(messages),
            chat_history=messages,
        )

        # Write to JSON file
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(export_data.model_dump_json(indent=4, exclude_none=True, warnings="none"))

        logger.info(f"Chat history exported to {filepath}")
        return filepath
