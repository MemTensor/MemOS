from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from memos.api.config import APIConfig
from memos.chunkers import ChunkerFactory
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.types.general_types import MemoryView


def test_product_default_config_wires_preference_extractor_model(monkeypatch):
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_MODEL", "pref-model")
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_API_BASE", "https://pref.example/v1")
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_API_KEY", "pref-key")

    config = APIConfig.get_product_default_config()["mem_reader"]["config"]

    pref_config = config["preference_extractor_llm"]
    assert pref_config["backend"] == "openai"
    assert pref_config["config"]["model_name_or_path"] == "pref-model"
    assert pref_config["config"]["api_base"] == "https://pref.example/v1"
    assert pref_config["config"]["api_key"] == "pref-key"


def test_preference_extractor_qwen35_disables_thinking(monkeypatch):
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_MODEL", "qwen3.5-flash")
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_API_BASE", "https://dashscope.example/v1")
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_API_KEY", "pref-key")

    pref_config = APIConfig.get_preference_extractor_llm_config()

    assert pref_config["config"]["extra_body"] == {"enable_thinking": False}


def test_preference_extractor_qwen36_disables_thinking(monkeypatch):
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_MODEL", "qwen3.6-flash")
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_API_BASE", "https://dashscope.example/v1")
    monkeypatch.setenv("PREFERENCE_EXTRACTOR_API_KEY", "pref-key")

    pref_config = APIConfig.get_preference_extractor_llm_config()

    assert pref_config["config"]["extra_body"] == {"enable_thinking": False}


def test_product_default_config_leaves_preference_extractor_unset_without_model(monkeypatch):
    monkeypatch.delenv("PREFERENCE_EXTRACTOR_MODEL", raising=False)
    monkeypatch.delenv("PREFERENCE_EXTRACTOR_API_BASE", raising=False)
    monkeypatch.delenv("PREFERENCE_EXTRACTOR_API_KEY", raising=False)

    config = APIConfig.get_product_default_config()["mem_reader"]["config"]

    assert config["preference_extractor_llm"] is None


def test_simple_reader_uses_configured_preference_extractor_llm():
    main_llm = object()
    general_llm = object()
    preference_llm = object()

    config = SimpleNamespace(
        llm="main-config",
        general_llm="general-config",
        preference_extractor_llm="preference-config",
        qwen_llm=None,
        embedder="embedder-config",
        chunker="chunker-config",
        remove_prompt_example=False,
    )
    chunker = MagicMock()
    chunker.config.save_rawfile = False

    with (
        patch.object(
            LLMFactory,
            "from_config",
            side_effect=[main_llm, general_llm, preference_llm],
        ),
        patch.object(EmbedderFactory, "from_config", return_value=MagicMock()),
        patch.object(ChunkerFactory, "from_config", return_value=chunker),
    ):
        reader = SimpleStructMemReader(config)

    assert reader.llm is main_llm
    assert reader.general_llm is general_llm
    assert reader.preference_extractor_llm is preference_llm


def test_simple_reader_preference_extractor_llm_falls_back_to_general_llm():
    main_llm = object()
    general_llm = object()

    config = SimpleNamespace(
        llm="main-config",
        general_llm="general-config",
        preference_extractor_llm=None,
        qwen_llm=None,
        embedder="embedder-config",
        chunker="chunker-config",
        remove_prompt_example=False,
    )
    chunker = MagicMock()
    chunker.config.save_rawfile = False

    with (
        patch.object(LLMFactory, "from_config", side_effect=[main_llm, general_llm]),
        patch.object(EmbedderFactory, "from_config", return_value=MagicMock()),
        patch.object(ChunkerFactory, "from_config", return_value=chunker),
    ):
        reader = SimpleStructMemReader(config)

    assert reader.llm is main_llm
    assert reader.general_llm is general_llm
    assert reader.preference_extractor_llm is general_llm


def test_multimodal_transfer_uses_preference_extractor_llm():
    reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
    reader.general_llm = object()
    reader.preference_extractor_llm = object()
    reader.embedder = object()
    reader.searcher = None
    reader.graph_db = None
    reader.oss_config = None
    reader.skills_dir_config = None
    reader.multi_modal_parser = MagicMock()
    reader.multi_modal_parser.process_transfer.return_value = []

    raw_node = TextualMemoryItem(
        memory="User likes concise answers.",
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="u1",
            session_id="s1",
            memory_type="LongTermMemory",
            sources=[SourceMessage(type="chat", role="user", content="I like concise answers.")],
        ),
    )

    with (
        patch.object(reader, "_process_string_fine", return_value=[]),
        patch.object(reader, "_process_tool_trajectory_fine", return_value=[]),
        patch("memos.mem_reader.multi_modal_struct.process_skill_memory_fine", return_value=[]),
        patch(
            "memos.mem_reader.multi_modal_struct.process_preference_fine", return_value=[]
        ) as mock_process_pref,
    ):
        reader._process_transfer_multi_modal_data(
            [raw_node], allow_memory_view=[MemoryView.PREFERENCE]
        )

    assert mock_process_pref.call_args.args[2] is reader.preference_extractor_llm
