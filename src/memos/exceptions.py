"""Custom exceptions for the MemOS library.

This module defines all custom exceptions used throughout the MemOS project.
All exceptions inherit from a base MemOSError class to provide a consistent
error handling interface.
"""


class MemOSError(Exception): ...


class ConfigurationError(MemOSError): ...


class MemoryError(MemOSError): ...


class MemCubeError(MemOSError): ...


class VectorDBError(MemOSError): ...


class LLMError(MemOSError): ...


class LLMRateLimitError(LLMError):
    """Local admission failed; do not bypass it through model retries or fallback."""


class LLMRateLimitTimeoutError(LLMRateLimitError): ...


class LLMRateLimitQueueFullError(LLMRateLimitError): ...


class LLMRateLimitUnavailableError(LLMRateLimitError): ...


class EmbedderError(MemOSError): ...


class ParserError(MemOSError): ...


class LLMResponseParseError(ParserError):
    """Raised when an LLM response cannot be parsed into the expected shape.

    Used in place of a silent ``{}`` return so that callers can distinguish
    "the model produced no memories" from "the model produced output we
    couldn't parse". Issue #2456.
    """
