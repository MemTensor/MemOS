from memos.configs.base import BaseConfig
from typing import Any, ClassVar
from pydantic import Field
from pydantic import field_validator, model_validator
from memos.configs.vec_db import VectorDBConfigFactory
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.llm import LLMConfigFactory



class BaseBuilderConfig(BaseConfig):
    """Base configuration class for Builder."""


class NaiveBuilderConfig(BaseBuilderConfig):
    """Configuration for Naive Builder."""
    # No additional config needed since components are passed from parent



class BuilderConfigFactory(BaseConfig):
    """Factory class for creating Builder configurations."""

    backend: str = Field(..., description="Backend for Builder")
    config: dict[str, Any] = Field(..., description="Configuration for the Builder backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveBuilderConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "BuilderConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self


class BaseRetrieverConfig(BaseConfig):
    """Base configuration class for Retriever."""


class NaiveRetrieverConfig(BaseRetrieverConfig):
    """Configuration for Naive Retriever."""


class RetrieverConfigFactory(BaseConfig):
    """Factory class for creating Retriever configurations."""

    backend: str = Field(..., description="Backend for Retriever")
    config: dict[str, Any] = Field(..., description="Configuration for the Retriever backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveRetrieverConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "RetrieverConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self


class BaseUpdaterConfig(BaseConfig):
    """Base configuration class for Updater."""


class NaiveUpdaterConfig(BaseUpdaterConfig):
    """Configuration for Naive Updater."""


class UpdaterConfigFactory(BaseConfig):
    """Factory class for creating Updater configurations."""

    backend: str = Field(..., description="Backend for Updater")
    config: dict[str, Any] = Field(..., description="Configuration for the Updater backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveUpdaterConfig,
    }
    
    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "UpdaterConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self


class BaseAssemblerConfig(BaseConfig):
    """Base configuration class for Assembler."""


class NaiveAssemblerConfig(BaseAssemblerConfig):
    """Configuration for Naive Assembler."""


class AssemblerConfigFactory(BaseConfig):
    """Factory class for creating Assembler configurations."""

    backend: str = Field(..., description="Backend for Assembler")
    config: dict[str, Any] = Field(..., description="Configuration for the Assembler backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveAssemblerConfig,
    }
    
    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "AssemblerConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self

