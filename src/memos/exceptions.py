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


class GraphDBError(MemOSError): ...


class LLMError(MemOSError): ...


class EmbedderError(MemOSError): ...


class ParserError(MemOSError): ...
