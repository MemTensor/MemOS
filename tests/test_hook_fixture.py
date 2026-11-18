import pytest

from memos.plugins.hook_defs import define_hook
from memos.plugins.hooks import _hooks, register_hook


@pytest.fixture
def existing_hooks():
    saved = {name: list(callbacks) for name, callbacks in _hooks.items()}
    define_hook("fixture.existing", description="Existing registration", params=[])
    register_hook("fixture.existing", lambda: None)
    expected = {name: list(callbacks) for name, callbacks in _hooks.items()}
    try:
        yield
        assert dict(_hooks) == expected
    finally:
        _hooks.clear()
        _hooks.update(saved)


def test_clean_hooks_restores_existing_registrations(existing_hooks, request):
    request.getfixturevalue("clean_hooks")
    assert not _hooks
    register_hook("fixture.existing", lambda: None)
