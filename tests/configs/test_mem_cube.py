import json

from memos.configs.mem_cube import BaseMemCubeConfig, GeneralMemCubeConfig
from tests.utils import (
    check_config_base_class,
    check_config_instantiation_invalid,
    check_config_instantiation_valid,
)


def test_base_mem_cube_config():
    check_config_base_class(
        BaseMemCubeConfig,
        factory_fields=[],
        required_fields=[],
        optional_fields=["model_schema", "config_filename"],
        reserved_fields=[],
    )

    check_config_instantiation_valid(
        BaseMemCubeConfig,
        {},
    )

    check_config_instantiation_invalid(BaseMemCubeConfig)


def test_general_mem_cube_config():
    check_config_base_class(
        GeneralMemCubeConfig,
        factory_fields=["text_mem", "act_mem", "para_mem", "pref_mem"],
        required_fields=[],
        optional_fields=["config_filename", "user_id", "cube_id"],
        reserved_fields=["model_schema"],
    )

    with open("examples/data/mem_cube_2/config.json") as f:
        config_data = json.load(f)

    check_config_instantiation_valid(
        GeneralMemCubeConfig,
        config_data,
    )

    config_data["text_mem"]["backend"] = "kv_cache"  # Invalid backend for text_mem
    check_config_instantiation_invalid(GeneralMemCubeConfig, config_data)
