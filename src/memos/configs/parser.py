from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class BaseParserConfig(BaseConfig):
    """Base configuration class for parser models."""


class MarkItDownParserConfig(BaseParserConfig):
    pass


class ParserConfigFactory(BaseConfig):
    """Factory class for creating Parser configurations."""

    backend: str = Field(..., description="Backend for parser")
    config: BaseParserConfig = Field(..., description="Configuration for the parser backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "markitdown": MarkItDownParserConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="before")
    @classmethod
    def create_config(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        if "backend" not in data or "config" not in data:
            return data

        config_class = cls.backend_to_class.get(data["backend"])
        if config_class is None:
            return data

        config = data.get("config")
        if isinstance(config, config_class):
            return data

        data = data.copy()
        data["config"] = config_class.model_validate(config)
        return data
