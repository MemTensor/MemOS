from dataclasses import dataclass, field


@dataclass
class ParsedTaskGoal:
    """
    Goal structure for both Fast & LLM.
    """

    memories: list[str] = field(default_factory=list)
    keys: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    rephrased_query: str | None = None
    internet_search: bool = False
    goal_type: str | None = None  # e.g., 'default', 'explanation', etc.
    context: str = ""
