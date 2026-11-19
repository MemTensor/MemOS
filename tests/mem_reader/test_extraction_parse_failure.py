from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from memos.exceptions import LLMResponseParseError
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.mem_reader.utils import parse_json_result
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


@pytest.fixture(params=[SimpleStructMemReader, MultiModalStructMemReader])
def reader(request):
    instance = request.param.__new__(request.param)
    instance.config = SimpleNamespace(remove_prompt_example=False)
    instance.llm = MagicMock()
    instance.general_llm = MagicMock()
    instance.embedder = MagicMock()
    instance.embedder.embed.side_effect = lambda texts: [[0.1] for _ in texts]
    instance.chat_window_max_tokens = 1024
    instance.memory_version_switch = "off"
    instance.save_rawfile = False
    return instance


@pytest.mark.parametrize("response", ["", "prose", '{"memory list": [}', "[]", '[{"x": 1}]'])
def test_fine_extraction_propagates_parse_failure(reader, response):
    reader.llm.generate.return_value = response
    with pytest.raises(LLMResponseParseError):
        reader._get_llm_response("Synthetic input", None)


@pytest.mark.parametrize("response", ["{}", '{"memory list": []}'])
def test_empty_extraction_is_success_without_fallback(reader, response):
    reader.llm.generate.return_value = response
    assert reader._get_llm_response("Synthetic input", None) == parse_json_result(response)


def test_multimodal_worker_cannot_hide_parse_failure():
    reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
    reader.config = SimpleNamespace(remove_prompt_example=False)
    reader.llm = MagicMock()
    reader.llm.generate.return_value = "malformed extraction"
    reader.memory_version_switch = "off"
    reader.save_rawfile = False
    item = TextualMemoryItem(
        memory="Synthetic input",
        metadata=TreeNodeTextualMemoryMetadata(sources=[]),
    )
    with pytest.raises(LLMResponseParseError):
        reader._process_string_fine([item], {})


@pytest.mark.parametrize("reader_cls", [SimpleStructMemReader, MultiModalStructMemReader])
def test_public_reader_propagates_worker_parse_failure(monkeypatch, reader_cls):
    reader = reader_cls.__new__(reader_cls)
    error = LLMResponseParseError("Synthetic parse failure")

    def fail(*args, **kwargs):
        raise error

    method = (
        "_process_multi_modal_data"
        if reader_cls is MultiModalStructMemReader
        else "_process_chat_data"
    )
    monkeypatch.setattr(reader, method, fail)
    with pytest.raises(LLMResponseParseError, match="Synthetic parse failure"):
        reader.get_memory(
            [[{"role": "user", "content": "Synthetic input"}]],
            "chat",
            {"user_id": "synthetic-user", "session_id": "synthetic-session"},
            mode="fine",
        )
