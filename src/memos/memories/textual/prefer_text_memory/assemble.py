from abc import ABC, abstractmethod

from memos.memories.textual.item import TextualMemoryItem


class BaseAssembler(ABC):
    """Abstract base class for assemblers."""

    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the assembler."""

    @abstractmethod
    def get_instruction(
        self, query: str, memories: list[TextualMemoryItem], assemble_strategy: str = "semi"
    ) -> str:
        """Assemble query and memories into a single memory.
        Args:
            query: The query to assemble.
            memories: The memories to assemble.
            assemble_strategy: The strategy to assemble the memories. option: [raw, semi, full]
        Returns:
            The assembled prompt.
        """


class NaiveAssembler(BaseAssembler):
    """Naive assembler."""

    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive assembler."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def get_instruction(
        self, query: str, memories: list[TextualMemoryItem], assemble_strategy: str = "semi"
    ) -> str:
        """Assemble query and memories into a single memory."""

        # Initialize all memory lists
        mems = {
            "textual_mems": [],
            "explicit_prefs": [],
            "implicit_prefs": [],
        }

        for memory in memories:
            if memory.metadata.preference_type == "explicit_preference":
                mems["explicit_prefs"].append(memory.metadata.explicit_preference)
            elif memory.metadata.preference_type == "implicit_preference":
                mems["implicit_prefs"].append(memory.metadata.implicit_preference)
            else:
                mems["textual_mems"].append(memory.memory)

        # Build memories string with different titles for different types
        memories_parts = []
        if mems["textual_mems"]:
            memories_parts.append("## Textual Memories:")
            for i, mem in enumerate(mems["textual_mems"], 1):
                memories_parts.append(f"{i}. {mem}")
        if mems["explicit_prefs"]:
            memories_parts.append("## Explicit Preferences:")
            for i, pref in enumerate(mems["explicit_prefs"], 1):
                memories_parts.append(f"{i}. {pref}")

        if mems["implicit_prefs"]:
            memories_parts.append("\n## Implicit Preferences:")
            for i, pref in enumerate(mems["implicit_prefs"], 1):
                memories_parts.append(f"{i}. {pref}")

        memories_str = "\n".join(memories_parts)

        system_prompt = (
            "You are a knowledgeable and helpful AI assistant. "
            "You have access to conversation memories that help you provide more personalized responses. "
            "Use the memories to understand the user's context, preferences, and past interactions. "
            "If memories are provided, reference them naturally when relevant, but don't explicitly mention having memories."
            f"\n\n## Memories:\n{memories_str}"
        )

        if assemble_strategy == "raw":
            return system_prompt.replace("{memories}", memories_str)
        elif assemble_strategy == "semi":
            return (
                system_prompt
                + (
                    "Note: Textual memories are summaries of facts, while preference memories are summaries of user preferences. "
                    + "Your response must not violate any of the user's preferences, whether explicit or implicit, and briefly explain why you answer this way to avoid conflicts."
                    + "When encountering preference conflicts, the priority is: explicit preferences > implicit preferences > textual memories."
                )
            ).replace("{memories}", memories_str)
        else:
            raise ValueError(f"Invalid assemble strategy: {assemble_strategy}")
