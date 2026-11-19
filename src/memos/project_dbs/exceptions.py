"""Storage-layer errors. The API layer maps each to an error code."""

from memos.exceptions import MemOSError


class ProjectDBError(MemOSError): ...


class SpaceNotFoundError(ProjectDBError):
    """Space does not exist or does not belong to the given project."""


class DomainNotFoundError(ProjectDBError):
    """Domain is not registered in the space."""


class DomainAlreadyExistsError(ProjectDBError):
    """Renaming would collide with another domain in the same space."""


class DomainInUseError(ProjectDBError):
    """Domain is still referenced by a topic; the whole batch is rejected."""


class DomainLimitExceededError(ProjectDBError):
    """Space would exceed the maximum number of domains."""


class TopicNotFoundError(ProjectDBError):
    """Topic does not exist or does not belong to the given project."""


class EntryNotFoundError(ProjectDBError):
    """Entry does not exist or does not belong to the given project."""


class UpdateConflictError(ProjectDBError):
    """update_time supplied by the caller differs from the stored value."""
