from typing import Any, ClassVar

from memos.configs.mem_scheduler import SchedulerConfigFactory
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.general_scheduler import GeneralScheduler
from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler


class SchedulerFactory(BaseScheduler):
    """Factory class for creating scheduler instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "general_scheduler": GeneralScheduler,
        "optimized_scheduler": OptimizedScheduler,
    }

    @classmethod
    def from_config(cls, config_factory: SchedulerConfigFactory) -> GeneralScheduler:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        mem_scheduler_class = cls.backend_to_class[backend]
        return mem_scheduler_class(config_factory.config)
