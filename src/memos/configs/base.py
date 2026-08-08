import os

from typing import Any

import logging
import yaml

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)


class BaseConfig(BaseModel):
    """Base configuration.

    All configurations should inherit from this class.
    This class uses Pydantic's ConfigDict to enforce strict validation
    and forbids extra fields."""

    model_schema: str = Field(
        "NOT_SET",
        description="Schema for configuration. This value will be automatically set.",
        exclude=True,
    )

    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="after")
    def set_default_schema(self) -> "BaseConfig":
        dot_path_schema = self.__module__ + "." + self.__class__.__name__
        if self.model_schema == dot_path_schema:
            return self
        if self.model_schema != "NOT_SET":
            logger.warning(
                f"Schema is set to {self.model_schema}, but it should be {dot_path_schema}. "
                "Changing schema to the default value."
            )
        self.model_schema = dot_path_schema
        return self

    @classmethod
    def from_json_file(cls, json_path: str) -> Any:
        """Load configuration from a JSON file."""
        with open(json_path, encoding="utf-8") as f:
            data = f.read()
        return cls.model_validate_json(data)

    def to_json_file(self, json_path: str) -> None:
        """Dump configuration to a JSON file."""
        dir_path = os.path.dirname(json_path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)
        with open(json_path, "w", encoding="utf-8") as f:
            f.write(self.model_dump_json(indent=2, warnings="none"))

    @classmethod
    def from_yaml_file(cls, yaml_path: str) -> Any:
        """Load configuration from a YAML file."""
        with open(yaml_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return cls.model_validate(data)

    def to_yaml_file(self, yaml_path: str) -> None:
        """Dump configuration to a YAML file."""

        dir_path = os.path.dirname(yaml_path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)

        with open(yaml_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(
                self.model_dump(mode="json", warnings="none"),
                f,
                default_flow_style=False,
                allow_unicode=True,
                indent=2,
            )

    def get(self, key, default=None):
        return getattr(self, key, default)
