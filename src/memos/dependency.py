"""
This utility provides tools for managing dependencies in MemOS.
"""

import functools
import importlib


def require_python_package(
    import_name: str, install_command: str | None = None, install_link: str | None = None
):
    """Check if a package is available and provide installation hints on import failure.

    Args:
        import_name (str): The top-level importable module name a package provides.
        install_command (str, optional): Installation command.
        install_link (str, optional): URL link to installation guide.

    Returns:
        Callable: A decorator function that wraps the target function with package availability check.

    Raises:
        ImportError: When the specified package is not available, with installation
            instructions included in the error message.

    Example:
        >>> @require_python_package(
        ...     import_name='faiss',
        ...     install_command='pip install faiss-cpu',
        ...     install_link='https://github.com/facebookresearch/faiss/blob/main/INSTALL.md'
        ... )
        ... def create_faiss_index():
        ...     from faiss import IndexFlatL2  # Actual import in function
        ...     return IndexFlatL2(128)
    """

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            try:
                importlib.import_module(import_name)
            except ImportError:
                error_msg = f"Missing required module - '{import_name}'\n"
                error_msg += f"💡 Install command: {install_command}\n" if install_command else ""
                error_msg += f"💡 Install guide:   {install_link}\n" if install_link else ""

                raise ImportError(error_msg) from None
            return func(*args, **kwargs)

        return wrapper

    return decorator
