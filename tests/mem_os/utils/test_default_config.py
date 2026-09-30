"""Test suite for src/memos/mem_os/utils/default_config.py.

Focus: get_default_cube_config / get_default_config defensive behavior
when the caller passes an unknown text_mem_type value.

Related issue: #2441.
"""

import pytest

from memos.mem_os.utils.default_config import (
    get_default_config,
    get_default_cube_config,
)


class TestGetDefaultCubeConfigInvalidTextMemType:
    """`get_default_cube_config` must raise a clear ValueError, not UnboundLocalError."""

    def test_invalid_text_mem_type_raises_value_error(self):
        """Passing a typo like 'tree-text' must raise ValueError (issue #2441)."""
        with pytest.raises(ValueError) as exc_info:
            get_default_cube_config(
                openai_api_key="sk-test",
                text_mem_type="tree-text",  # typo, should not crash silently
            )

        message = str(exc_info.value)
        # Error must name the offending value so operators can find their typo fast.
        assert "tree-text" in message
        # Error must list the accepted values so callers know what to use.
        assert "tree_text" in message
        assert "general_text" in message

    def test_invalid_text_mem_type_does_not_leak_unbound_local(self):
        """The old bug (issue #2441) raised UnboundLocalError; guard against regression."""
        with pytest.raises(ValueError):
            get_default_cube_config(
                openai_api_key="sk-test",
                text_mem_type="totally_unknown_backend",
            )

    def test_empty_text_mem_type_raises_value_error(self):
        """Empty string should also fail loudly, not fall through to UnboundLocalError."""
        with pytest.raises(ValueError):
            get_default_cube_config(
                openai_api_key="sk-test",
                text_mem_type="",  # type: ignore[arg-type]
            )


class TestGetDefaultConfigInvalidTextMemType:
    """`get_default_config` accepts the same text_mem_type parameter and should
    validate it symmetrically so both entry points fail with the same clear error
    when they receive garbage input.

    ``get_default_config`` and ``get_default_cube_config`` each call
    ``_validate_text_mem_type`` independently (they do not share a delegation
    path), so we mirror the same three regression cases here — a typo, an
    unknown backend name, and the empty string — to keep coverage symmetric
    across both entry points for issue #2441.
    """

    def test_invalid_text_mem_type_raises_value_error(self):
        with pytest.raises(ValueError) as exc_info:
            get_default_config(
                openai_api_key="sk-test",
                text_mem_type="tree-text",
            )

        message = str(exc_info.value)
        assert "tree-text" in message
        assert "tree_text" in message
        assert "general_text" in message

    def test_invalid_text_mem_type_does_not_leak_unbound_local(self):
        """Unknown backend names must fail with ValueError, not UnboundLocalError."""
        with pytest.raises(ValueError):
            get_default_config(
                openai_api_key="sk-test",
                text_mem_type="totally_unknown_backend",
            )

    def test_empty_text_mem_type_raises_value_error(self):
        """Empty string should also fail loudly, symmetric with the cube helper."""
        with pytest.raises(ValueError):
            get_default_config(
                openai_api_key="sk-test",
                text_mem_type="",  # type: ignore[arg-type]
            )


class TestGetDefaultCubeConfigValidTextMemType:
    """Valid values continue to build a MemCube config end-to-end."""

    def test_general_text_still_builds(self):
        cfg = get_default_cube_config(
            openai_api_key="sk-test",
            text_mem_type="general_text",
            user_id="issue2441_user",
        )
        assert cfg.text_mem.backend == "general_text"
