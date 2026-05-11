from __future__ import annotations

from typing import Any


class AbstractDreamPipeline:
    """Minimal Dream pipeline orchestrator.

    Community implementations can swap any strategy object to add richer motive formation,
    recall, reasoning, diary generation, or persistence without changing the scheduler contract.
    """

    def __init__(
        self,
        *,
        motive_strategy,
        recall_strategy,
        reasoning_strategy,
        diary_strategy,
        persistence_strategy,
    ) -> None:
        self.motive_strategy = motive_strategy
        self.recall_strategy = recall_strategy
        self.reasoning_strategy = reasoning_strategy
        self.diary_strategy = diary_strategy
        self.persistence_strategy = persistence_strategy
        self.context: dict[str, Any] = {}

    def bind_context(self, context: dict[str, Any]) -> None:
        self.context = context
        for component in (
            self.motive_strategy,
            self.recall_strategy,
            self.reasoning_strategy,
            self.diary_strategy,
            self.persistence_strategy,
        ):
            bind_context = getattr(component, "bind_context", None)
            if callable(bind_context):
                bind_context(context)

    def run(
        self,
        *,
        mem_cube_id: str,
        user_id: str,
        cube_id: str,
        signal_snapshot,
        text_mem,
    ):
        # Step 1: build Dream clusters from the scheduler payload.
        clusters = self.motive_strategy.form(
            signal_snapshot=signal_snapshot,
            text_mem=text_mem,
            cube_id=cube_id,
        )

        # Step 2: attach recall material to each cluster.
        clusters = self.recall_strategy.gather(
            clusters=clusters,
            text_mem=text_mem,
            cube_id=cube_id,
        )

        # Step 3a: convert recalled clusters into write intents.
        results = self.reasoning_strategy.reason(
            clusters=clusters,
            text_mem=text_mem,
            cube_id=cube_id,
        )

        # Step 3b: attach explainable diary artifacts.
        results = self.diary_strategy.generate(
            clusters=clusters,
            results=results,
            mem_cube_id=mem_cube_id,
        )

        # Step 4: hand persistence over to the final strategy.
        self.persistence_strategy.persist(
            results=results,
            text_mem=text_mem,
            cube_id=cube_id,
            mem_cube_id=mem_cube_id,
            user_id=user_id,
            signal_snapshot=signal_snapshot,
        )
        return results
