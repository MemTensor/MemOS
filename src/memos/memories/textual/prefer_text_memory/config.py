from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class BaseAdderConfig(BaseConfig):
    """Base configuration class for Adder."""


class NaiveAdderConfig(BaseAdderConfig):
    """Configuration for Naive Adder."""

    # No additional config needed since components are passed from parent


class AdderConfigFactory(BaseConfig):
    """Factory class for creating Adder configurations."""

    backend: str = Field(..., description="Backend for Adder")
    config: dict[str, Any] = Field(..., description="Configuration for the Adder backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveAdderConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "AdderConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self


class BaseExtractorConfig(BaseConfig):
    """Base configuration class for Extractor."""


class NaiveExtractorConfig(BaseExtractorConfig):
    """Configuration for Naive Extractor."""


class ExtractorConfigFactory(BaseConfig):
    """Factory class for creating Extractor configurations."""

    backend: str = Field(..., description="Backend for Extractor")
    config: dict[str, Any] = Field(..., description="Configuration for the Extractor backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveExtractorConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "ExtractorConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self


class BaseRetrieverConfig(BaseConfig):
    """Base configuration class for Retrievers."""


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
