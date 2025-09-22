"""
Singleton decorator module for caching factory instances to avoid excessive memory usage
from repeated initialization.
"""

import hashlib
import json

from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar
from weakref import WeakValueDictionary


T = TypeVar("T")


class FactorySingleton:
    """Factory singleton manager that caches instances based on configuration parameters"""

    def __init__(self):
        # Use weak reference dictionary for automatic cleanup when instances are no longer referenced
        self._instances: dict[str, WeakValueDictionary] = {}

    def _generate_cache_key(self, config: Any, *args, **kwargs) -> str:
        """Generate cache key based on configuration only (ignoring other parameters)"""

        # Handle configuration objects - only use the config parameter
        if hasattr(config, "model_dump"):  # Pydantic model
            config_data = config.model_dump()
        elif hasattr(config, "dict"):  # Legacy Pydantic model
            config_data = config.dict()
        elif isinstance(config, dict):
            config_data = config
        else:
            # For other types, try to convert to string
            config_data = str(config)

        # Filter out time-related fields that shouldn't affect caching
        filtered_config = self._filter_temporal_fields(config_data)

        # Generate hash key based only on config
        try:
            cache_str = json.dumps(filtered_config, sort_keys=True, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            # If JSON serialization fails, convert the entire config to string
            cache_str = str(filtered_config)

        return hashlib.md5(cache_str.encode("utf-8")).hexdigest()

    def _filter_temporal_fields(self, config_data: Any) -> Any:
        """Filter out temporal fields that shouldn't affect instance caching"""
        if isinstance(config_data, dict):
            filtered = {}
            for key, value in config_data.items():
                # Skip common temporal field names
                if key.lower() in {
                    "created_at",
                    "updated_at",
                    "timestamp",
                    "time",
                    "date",
                    "created_time",
                    "updated_time",
                    "last_modified",
                    "modified_at",
                    "start_time",
                    "end_time",
                    "execution_time",
                    "run_time",
                }:
                    continue
                # Recursively filter nested dictionaries
                filtered[key] = self._filter_temporal_fields(value)
            return filtered
        elif isinstance(config_data, list):
            # Recursively filter lists
            return [self._filter_temporal_fields(item) for item in config_data]
        else:
            # For primitive types, return as-is
            return config_data

    def get_or_create(self, factory_class: type, cache_key: str, creator_func: Callable) -> Any:
        """Get or create instance"""
        class_name = factory_class.__name__

        if class_name not in self._instances:
            self._instances[class_name] = WeakValueDictionary()

        class_cache = self._instances[class_name]

        if cache_key in class_cache:
            return class_cache[cache_key]

        # Create new instance
        instance = creator_func()
        class_cache[cache_key] = instance
        return instance

    def clear_cache(self, factory_class: type | None = None):
        """Clear cache"""
        if factory_class:
            class_name = factory_class.__name__
            if class_name in self._instances:
                self._instances[class_name].clear()
        else:
            for cache in self._instances.values():
                cache.clear()


# Global singleton manager
_factory_singleton = FactorySingleton()


def singleton_factory(factory_class: type | str | None = None):
    """
    Factory singleton decorator

    Usage:
    @singleton_factory()
    def from_config(cls, config):
        return SomeClass(config)

    Or specify factory class:
    @singleton_factory(EmbedderFactory)
    def from_config(cls, config):
        return SomeClass(config)
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args, **kwargs) -> T:
            # Determine factory class and config parameter
            target_factory_class = factory_class
            config = None

            # Simple logic: check if first parameter is a class or config
            if args:
                if hasattr(args[0], "__name__") and hasattr(args[0], "__module__"):
                    # First parameter is a class (cls), so this is a @classmethod
                    if target_factory_class is None:
                        target_factory_class = args[0]
                    config = args[1] if len(args) > 1 else None
                else:
                    # First parameter is config, so this is a @staticmethod
                    if target_factory_class is None:
                        raise ValueError(
                            "Factory class must be explicitly specified for static methods"
                        )
                    if isinstance(target_factory_class, str):
                        # Convert string to a mock class for caching purposes
                        class MockFactoryClass:
                            __name__ = target_factory_class

                        target_factory_class = MockFactoryClass
                    config = args[0]

            if config is None:
                # If no configuration parameter, call original function directly
                return func(*args, **kwargs)

            # Generate cache key based only on config
            cache_key = _factory_singleton._generate_cache_key(config)

            # Function to create instance
            def creator():
                return func(*args, **kwargs)

            # Get or create instance
            return _factory_singleton.get_or_create(target_factory_class, cache_key, creator)

        return wrapper

    return decorator
