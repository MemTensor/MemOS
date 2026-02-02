from enum import Enum

from pydantic import BaseModel


class NLIResult(Enum):
    DUPLICATE = "Duplicate"
    CONTRADICTION = "Contradiction"
    UNRELATED = "Unrelated"


class CompareRequest(BaseModel):
    source: str
    targets: list[str]


class CompareResponse(BaseModel):
    results: list[NLIResult]
