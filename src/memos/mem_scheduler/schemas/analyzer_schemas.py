import json

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from memos.log import get_logger


logger = get_logger(__name__)

FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent


class BasicRecordingCase(BaseModel):
    # Conversation identification
    conv_id: str = Field(description="Conversation identifier for this evaluation case")
    user_id: str = Field(description="User identifier for this evaluation case")
    memcube_id: str = Field(description="Memcube identifier for this evaluation case")

    # Query and answer information
    query: str = Field(description="The current question/query being evaluated")

    answer: str = Field(description="The generated answer for the query")

    golden_answer: str | None = Field(
        default=None, description="Ground truth answer for evaluation"
    )

    def to_dict(self) -> dict[str, Any]:
        return self.dict()

    def to_json(self, indent: int = 2) -> str:
        return self.json(indent=indent, ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BasicRecordingCase":
        return cls(**data)

    @classmethod
    def from_json(cls, json_str: str) -> "BasicRecordingCase":
        data = json.loads(json_str)
        return cls.from_dict(data)

    class Config:
        """Pydantic configuration"""

        extra = "allow"  # Allow additional fields not defined in the schema
        validate_assignment = True  # Validate on assignment
        use_enum_values = True  # Use enum values instead of enum names
