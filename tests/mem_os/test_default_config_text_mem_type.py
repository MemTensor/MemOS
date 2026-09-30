import pytest

from memos.mem_os.utils.default_config import get_default_cube_config


@pytest.mark.parametrize("bad_type", ["tree-text", "Tree_Text", ""])
def test_invalid_text_mem_type_raises_clear_error(bad_type):
    # an unrecognized text_mem_type used to crash with a bare
    # UnboundLocalError because text_mem_config was never assigned
    with pytest.raises(ValueError, match="text_mem_type must be"):
        get_default_cube_config(openai_api_key="sk-x", text_mem_type=bad_type)


@pytest.mark.parametrize("mem_type", ["tree_text", "general_text"])
def test_valid_text_mem_types_build_cube_config(mem_type):
    config = get_default_cube_config(openai_api_key="sk-x", text_mem_type=mem_type)
    assert config.text_mem.backend == mem_type
