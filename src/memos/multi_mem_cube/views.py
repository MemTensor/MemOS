from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol


if TYPE_CHECKING:
    from memos.api.product_models import APIADDRequest


class MemCubeView(Protocol):
    """
    A high-level cube view used by AddHandler.
    It may wrap a single logical cube or multiple cubes,
    but exposes a unified add_memories interface.
    """

    def add_memories(self, add_req: APIADDRequest) -> list[dict[str, Any]]:
        """
        Process add_req, extract memories and write them into one or more cubes.

        Returns:
            A list of memory dicts, each item should at least contain:
            - memory
            - memory_id
            - memory_type
            - cube_id
        """
        ...
