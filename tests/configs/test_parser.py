import warnings

from memos.configs.parser import BaseParserConfig, MarkItDownParserConfig, ParserConfigFactory
from tests.utils import (
    check_config_base_class,
    check_config_factory_class,
    check_config_instantiation_invalid,
    check_config_instantiation_valid,
)


def test_base_parser_config():
    check_config_base_class(
        BaseParserConfig,
        required_fields=[],
        optional_fields=[],
    )

    check_config_instantiation_valid(
        BaseParserConfig,
        {},
    )

    check_config_instantiation_invalid(BaseParserConfig)


def test_markitdown_parser_config():
    check_config_base_class(
        MarkItDownParserConfig,
        required_fields=[],
        optional_fields=[],
    )

    check_config_instantiation_valid(
        MarkItDownParserConfig,
        {},
    )

    check_config_instantiation_invalid(MarkItDownParserConfig)


def test_parser_config_factory():
    check_config_factory_class(
        ParserConfigFactory,
        expected_backends=["markitdown"],
    )

    check_config_instantiation_valid(
        ParserConfigFactory,
        {
            "backend": "markitdown",
            "config": {},
        },
    )

    check_config_instantiation_invalid(ParserConfigFactory)


def test_parser_config_factory_dump_without_serializer_warning():
    config = ParserConfigFactory.model_validate(
        {
            "backend": "markitdown",
            "config": {},
        }
    )

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        dumped = config.model_dump()

    assert dumped == {"backend": "markitdown", "config": {}}
    assert isinstance(config.config, MarkItDownParserConfig)
    assert not any("PydanticSerializationUnexpectedValue" in str(item.message) for item in caught)
