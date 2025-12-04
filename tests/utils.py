import inspect

from abc import ABC
from typing import Any

import pytest

from pydantic import BaseModel
from pydantic.aliases import PydanticUndefined


def check_module_base_class(cls: Any) -> None:
    """
    General function to test the correctness of an abstract base class.
    - It should inherit from ABC.
    - It should define at least one method.
    - All methods should be marked as @abstractmethod.
    - It should not be instantiable.
    - All methods should have docstrings.

    Args:
        cls: The abstract base class to test.
    """
    # Check 1: Ensure this is an abstract base class
    assert issubclass(cls, ABC), f"{cls.__name__} should inherit from ABC"

    # Get all non-excluded methods (excluding dunder methods, except for __init__)
    all_class_methods = [name for name, _ in inspect.getmembers(cls, predicate=inspect.isfunction)]

    # Check 2: Ensure the class defines methods
    assert all_class_methods, f"{cls.__name__} should define at least one method"

    # Check 3: Verify abstract methods
    for method_name in all_class_methods:
        method = getattr(cls, method_name)
        # Skip private methods (starting with _) as they are typically helper methods
        if method_name.startswith("_") and method_name != "__init__":
            continue
        assert getattr(method, "__isabstractmethod__", False), (
            f"The method '{method_name}' in {cls.__name__} should be marked as @abstractmethod"
        )

    # Check 4: Test that the class cannot be instantiated directly
    with pytest.raises(TypeError) as excinfo:
        cls()
    assert "abstract" in str(excinfo.value).lower(), (
        f"{cls.__name__} should not be instantiable as it's an abstract base class"
    )

    # Check 5: Ensure all methods have docstrings
    for method_name in all_class_methods:
        method = getattr(cls, method_name)
        assert method.__doc__, f"Method '{method_name}' in {cls.__name__} should have a docstring"


def check_module_factory_class(cls: Any) -> None:
    """
    Generic function to test factory classes.
    - It should inherit from a base class.
    - It should have a backend_to_class attribute.
    - It should have a from_config method.
    - All registered backends should have valid classes.
    - The backend_to_class attribute should be a dictionary.
    - The backend_to_class attribute should map strings to classes that are subclasses of the base class.

    Args:
        cls: The module factory class to test
    """
    # Check 1: Test if the module factory class is a subclass of the base class
    assert len(cls.__bases__) == 1, "Factory class should have exactly one base class"
    base_class = cls.__bases__[0]

    # Check 2: Test if the module factory class has a backend_to_class attribute
    assert hasattr(cls, "backend_to_class"), "Factory class should have backend_to_class attribute"
    assert isinstance(cls.backend_to_class, dict), "backend_to_class should be a dictionary"
    backend_to_module_mapping = cls.backend_to_class

    # Check 3: Test if the module factory class has a from_config method
    assert hasattr(cls, "from_config"), "Factory class should have from_config method"

    # Check 4: Test if all registered backends have valid classes
    for backend, module_class in backend_to_module_mapping.items():
        assert isinstance(backend, str), f"Backend '{backend}' should be a string"
        assert issubclass(module_class, base_class), (
            f"{module_class} should be a subclass of {base_class}"
        )


def check_config_base_class(
    cls: BaseModel,
    factory_fields: list[str] | None = None,
    required_fields: list[str] | None = None,
    optional_fields: list[str] | None = None,
    reserved_fields: list[str] | None = None,
) -> None:
    """
    Check if a configuration class is properly defined.
    - It should inherit from Pydantic's BaseModel.
    - It should have a model_config attribute.
    - It should have a model_fields attribute.
    - The factory_fields, required_fields, and optional_fields should be properly defined.
    - It should have a ConfigDict as model_config.

    Args:
        cls: The config class to check
        factory_fields: List of field names with default_factory.
        required_fields: List of field names that should be required, despite factory fields.
        optional_fields: List of field names that should be optional, despite factory fields.
        reserved_fields: List of field names that should be ignored in the checks.
            Like fields defined in `memos.configs.base.BaseConfig`.
    """
    if reserved_fields is None:
        reserved_fields = ["model_schema"]

    # Check if the class is a subclass of BaseModel
    assert inspect.isclass(cls), f"{cls} is not a class"
    assert issubclass(cls, BaseModel), f"{cls} is not a Pydantic BaseModel"

    # Check model_config
    assert cls.model_config == {"extra": "forbid", "strict": True}, (
        f"{cls} does not have the correct model_config"
    )

    # Check model_fields
    factory_fields = factory_fields or []
    required_fields = required_fields or []
    optional_fields = optional_fields or []
    actual_factory_fields = []
    actual_required_fields = []
    actual_optional_fields = []
    for field_name, field_info in cls.model_fields.items():
        if field_name in reserved_fields:
            continue
        elif field_info.default_factory is not None:
            actual_factory_fields.append(field_name)
        elif field_info.default == PydanticUndefined:
            actual_required_fields.append(field_name)
        else:
            actual_optional_fields.append(field_name)
    assert set(actual_factory_fields) == set(factory_fields), (
        f"{cls} has incorrect factory fields: expected {actual_factory_fields}, got {factory_fields}"
    )
    assert set(actual_required_fields) == set(required_fields), (
        f"{cls} has incorrect required fields: expected {actual_required_fields}, got {required_fields}"
    )
    assert set(actual_optional_fields) == set(optional_fields), (
        f"{cls} has incorrect optional fields: expected {actual_optional_fields}, got {optional_fields}"
    )


def check_config_factory_class(cls: BaseModel, expected_backends: list[str] | None = None) -> None:
    """
    Check if a configuration factory is properly defined.
    - It should inherit from Pydantic's BaseModel.
    - It should have a backend_to_class attribute.
    - It should have validate_backend and create_config methods.
    - Expected backends should be supported.

    Args:
        cls: The config factory class to check
        expected_backends: List of backend names that should be supported
    """
    assert inspect.isclass(cls), f"{cls} is not a class"
    assert issubclass(cls, BaseModel), f"{cls} is not a Pydantic BaseModel"

    # Check required attributes
    assert hasattr(cls, "backend_to_class"), f"{cls} has no backend_to_class attribute"
    assert isinstance(cls.backend_to_class, dict), f"{cls.backend_to_class} is not a dict"

    # Check required fields
    assert "backend" in cls.model_fields, f"{cls} is missing 'backend' field"
    assert "config" in cls.model_fields, f"{cls} is missing 'config' field"

    # Check validators
    assert hasattr(cls, "validate_backend"), f"{cls} has no validate_backend method"
    assert hasattr(cls, "create_config"), f"{cls} has no create_config method"

    # Check supported backends
    if expected_backends:
        for backend in expected_backends:
            assert backend in cls.backend_to_class, f"{cls} does not support {backend} backend"


def check_config_instantiation_valid(cls: BaseModel, valid_config: dict) -> None:
    """
    Test that a valid configuration can be instantiated.

    Args:
        cls: The config class to test
        valid_config: Dictionary of valid configuration values
    """
    config = cls.model_validate(valid_config)
    assert isinstance(config, cls)


def check_config_instantiation_invalid(cls: BaseModel, invalid_config: dict | None = None) -> None:
    """
    Test that invalid configurations raise the appropriate exceptions.

    Args:
        cls: The config class to test
        invalid_config: Dictionary of invalid configuration values
    """
    invalid_configs = [
        {"impossible_field": "invalid_value"},
        {"another_impossible_field": 2},
        {"abcdef": 0.1, "ghijk": "lmn"},
    ]
    if invalid_config is not None:
        invalid_configs.append(invalid_config)
    for invalid_config in invalid_configs:
        with pytest.raises((ValueError, TypeError, Exception)):
            cls.model_validate(invalid_config)
