import pytest


@pytest.fixture
def clean_hooks():
    """Keep Hook registrations isolated for tests that opt into this fixture."""
    from memos.plugins.hooks import _hooks

    saved = {name: list(callbacks) for name, callbacks in _hooks.items()}
    _hooks.clear()
    try:
        yield
    finally:
        _hooks.clear()
        _hooks.update(saved)
