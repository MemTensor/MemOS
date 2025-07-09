"""Configuration classes for internet retrievers."""

from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig
from memos.exceptions import ConfigurationError


class BaseInternetRetrieverConfig(BaseConfig):
    """Base configuration class for internet retrievers."""

    api_key: str = Field(..., description="API key for the search service")
    search_engine_id: str | None = Field(
        None, description="Search engine ID (required for Google Custom Search)"
    )


class GoogleCustomSearchConfig(BaseInternetRetrieverConfig):
    """Configuration class for Google Custom Search API."""

    search_engine_id: str = Field(..., description="Google Custom Search Engine ID (cx parameter)")
    max_results: int = Field(default=20, description="Maximum number of results to retrieve")
    num_per_request: int = Field(
        default=10, description="Number of results per API request (max 10 for Google)"
    )


class BingSearchConfig(BaseInternetRetrieverConfig):
    """Configuration class for Bing Search API."""

    endpoint: str = Field(
        default="https://api.bing.microsoft.com/v7.0/search", description="Bing Search API endpoint"
    )
    max_results: int = Field(default=20, description="Maximum number of results to retrieve")
    num_per_request: int = Field(default=10, description="Number of results per API request")


class XinyuSearchConfig(BaseInternetRetrieverConfig):
    """Configuration class for Xinyu Search API."""

    search_engine_id: str | None = Field(
        None, description="Not used for Xinyu Search (kept for compatibility)"
    )
    max_results: int = Field(default=20, description="Maximum number of results to retrieve")
    num_per_request: int = Field(
        default=10, description="Number of results per API request (not used for Xinyu)"
    )


class InternetRetrieverConfigFactory(BaseConfig):
    """Factory class for creating internet retriever configurations."""

    backend: str | None = Field(
        None, description="Backend for internet retriever (google, bing, etc.)"
    )
    config: dict[str, Any] | None = Field(
        None, description="Configuration for the internet retriever backend"
    )

    backend_to_class: ClassVar[dict[str, Any]] = {
        "google": GoogleCustomSearchConfig,
        "bing": BingSearchConfig,
        "xinyu": XinyuSearchConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str | None) -> str | None:
        """Validate the backend field."""
        if backend is not None and backend not in cls.backend_to_class:
            raise ConfigurationError(f"Invalid internet retriever backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "InternetRetrieverConfigFactory":
        if self.backend is not None:
            config_class = self.backend_to_class[self.backend]
            self.config = config_class(**self.config)
        return self
