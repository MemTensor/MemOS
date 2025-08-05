"""
Test ThreadSafeDict basic functionality to ensure it behaves like a regular dict.
"""

import threading
import time

import pytest

from memos.memos_tools.thread_safe_dict import SimpleThreadSafeDict, ThreadSafeDict


class TestThreadSafeDict:
    """Test ThreadSafeDict basic dictionary operations."""

    def test_basic_operations(self):
        """Test basic dict-like operations."""
        # Create empty dict
        safe_dict = ThreadSafeDict()
        assert len(safe_dict) == 0
        assert not safe_dict  # Test __bool__

        # Test setting and getting
        safe_dict["key1"] = "value1"
        safe_dict["key2"] = "value2"

        assert len(safe_dict) == 2
        assert bool(safe_dict)  # Test __bool__
        assert safe_dict["key1"] == "value1"
        assert safe_dict["key2"] == "value2"

        # Test contains
        assert "key1" in safe_dict
        assert "key3" not in safe_dict

        # Test get method
        assert safe_dict.get("key1") == "value1"
        assert safe_dict.get("key3") is None
        assert safe_dict.get("key3", "default") == "default"

    def test_initialization_with_dict(self):
        """Test initialization with existing dictionary."""
        initial_dict = {"a": 1, "b": 2, "c": 3}
        safe_dict = ThreadSafeDict(initial_dict)

        assert len(safe_dict) == 3
        assert safe_dict["a"] == 1
        assert safe_dict["b"] == 2
        assert safe_dict["c"] == 3

    def test_iteration_methods(self):
        """Test keys(), values(), items() and __iter__."""
        safe_dict = ThreadSafeDict({"a": 1, "b": 2, "c": 3})

        # Test keys()
        keys = safe_dict.keys()
        assert set(keys) == {"a", "b", "c"}

        # Test values()
        values = safe_dict.values()
        assert set(values) == {1, 2, 3}

        # Test items()
        items = safe_dict.items()
        assert set(items) == {("a", 1), ("b", 2), ("c", 3)}

        # Test __iter__
        iter_keys = list(safe_dict)
        assert set(iter_keys) == {"a", "b", "c"}

        # Test iteration with for loop
        collected_keys = []
        for key in safe_dict:
            collected_keys.append(key)
        assert set(collected_keys) == {"a", "b", "c"}

    def test_delete_operations(self):
        """Test deletion operations."""
        safe_dict = ThreadSafeDict({"a": 1, "b": 2, "c": 3})

        # Test __delitem__
        del safe_dict["b"]
        assert len(safe_dict) == 2
        assert "b" not in safe_dict
        assert "a" in safe_dict
        assert "c" in safe_dict

        # Test pop
        value = safe_dict.pop("a")
        assert value == 1
        assert len(safe_dict) == 1
        assert "a" not in safe_dict

        # Test pop with default
        value = safe_dict.pop("nonexistent", "default")
        assert value == "default"

        # Test clear
        safe_dict.clear()
        assert len(safe_dict) == 0
        assert not safe_dict

    def test_update_operations(self):
        """Test update and setdefault operations."""
        safe_dict = ThreadSafeDict({"a": 1})

        # Test update
        safe_dict.update({"b": 2, "c": 3})
        assert len(safe_dict) == 3
        assert safe_dict["b"] == 2
        assert safe_dict["c"] == 3

        # Test update with kwargs
        safe_dict.update(d=4, e=5)
        assert safe_dict["d"] == 4
        assert safe_dict["e"] == 5

        # Test setdefault
        result = safe_dict.setdefault("f", 6)
        assert result == 6
        assert safe_dict["f"] == 6

        # Test setdefault on existing key
        result = safe_dict.setdefault("a", 999)
        assert result == 1  # Should return existing value
        assert safe_dict["a"] == 1  # Should not change

    def test_copy_method(self):
        """Test copy method."""
        safe_dict = ThreadSafeDict({"a": 1, "b": 2})
        copied = safe_dict.copy()

        assert copied == {"a": 1, "b": 2}
        assert isinstance(copied, dict)  # Should return regular dict

        # Modify original, copy should not change
        safe_dict["c"] = 3
        assert "c" not in copied

    def test_string_representation(self):
        """Test __str__ and __repr__ methods."""
        safe_dict = ThreadSafeDict({"a": 1, "b": 2})

        str_repr = str(safe_dict)
        assert "a" in str_repr and "b" in str_repr

        repr_str = repr(safe_dict)
        assert "ThreadSafeDict" in repr_str
        assert "a" in repr_str and "b" in repr_str

    def test_exception_handling(self):
        """Test that exceptions are raised appropriately."""
        safe_dict = ThreadSafeDict()

        # Test KeyError on missing key
        with pytest.raises(KeyError):
            _ = safe_dict["nonexistent"]

        with pytest.raises(KeyError):
            del safe_dict["nonexistent"]

        with pytest.raises(KeyError):
            safe_dict.pop("nonexistent")

    def test_concurrent_access_basic(self):
        """Basic test for concurrent access without errors."""
        safe_dict = ThreadSafeDict()
        errors = []

        def writer():
            try:
                for i in range(50):
                    safe_dict[f"key_{i}"] = f"value_{i}"
                    time.sleep(0.001)  # Small delay
            except Exception as e:
                errors.append(f"Writer error: {e}")

        def reader():
            try:
                for _ in range(100):
                    # Try to read and iterate
                    if safe_dict:
                        for key in safe_dict:
                            _ = safe_dict.get(key, "default")
                    time.sleep(0.001)  # Small delay
            except Exception as e:
                errors.append(f"Reader error: {e}")

        # Start threads
        threads = []
        threads.append(threading.Thread(target=writer))
        threads.append(threading.Thread(target=reader))

        for thread in threads:
            thread.start()

        for thread in threads:
            thread.join()

        # Should not have any errors
        assert len(errors) == 0, f"Concurrent access errors: {errors}"


class TestSimpleThreadSafeDict:
    """Test SimpleThreadSafeDict basic functionality."""

    def test_basic_operations_simple(self):
        """Test that SimpleThreadSafeDict works like regular dict."""
        simple_dict = SimpleThreadSafeDict({"a": 1, "b": 2})

        assert len(simple_dict) == 2
        assert simple_dict["a"] == 1
        assert "a" in simple_dict
        assert simple_dict.get("c", "default") == "default"

        # Test modification
        simple_dict["c"] = 3
        assert simple_dict["c"] == 3

        # Test iteration
        keys = list(simple_dict.keys())
        assert set(keys) == {"a", "b", "c"}


def test_both_implementations_equivalent():
    """Test that both ThreadSafeDict and SimpleThreadSafeDict behave the same."""
    initial_data = {"x": 10, "y": 20, "z": 30}

    dict1 = ThreadSafeDict(initial_data)
    dict2 = SimpleThreadSafeDict(initial_data)

    # Test equivalent operations
    operations = [
        lambda d: d.get("x"),
        lambda d: len(d),
        lambda d: "x" in d,
        lambda d: list(d.keys()),
        lambda d: list(d.values()),
        lambda d: list(d.items()),
    ]

    for op in operations:
        result1 = op(dict1)
        result2 = op(dict2)
        assert result1 == result2, f"Results differ for operation: {op}"
