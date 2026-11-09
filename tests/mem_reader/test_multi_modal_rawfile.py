from unittest.mock import MagicMock, patch

from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)


def test_mixed_file_source_creates_rawfile_without_changing_prompt_type():
    reader = MultiModalStructMemReader.__new__(MultiModalStructMemReader)
    reader.save_rawfile = True
    reader.memory_version_switch = "off"
    reader.embedder = MagicMock()
    reader.embedder.embed.return_value = [[0.1]]
    reader.multi_modal_parser = MagicMock()

    file_info = {
        "file_id": "file-1",
        "filename": "knowledge.txt",
        "file_data": "Complete file content",
    }
    file_source = SourceMessage(
        type="file",
        role=None,
        content="Current file chunk",
        file_info=file_info,
    )
    fast_item = TextualMemoryItem(
        memory="Please parse this file\nCurrent file chunk\nRecord it completely",
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="user-1",
            session_id="session-1",
            memory_type="LongTermMemory",
            sources=[
                SourceMessage(type="chat", role="user", content="Please parse this file"),
                file_source,
                SourceMessage(type="chat", role="user", content="Record it completely"),
            ],
            file_ids=[file_info["file_id"]],
        ),
    )
    reader.multi_modal_parser.file_content_parser.create_source.return_value = SourceMessage(
        type="file",
        content=file_source.content,
        doc_path=file_info["filename"],
    )

    llm_response = {
        "memory list": [
            {
                "key": "Knowledge summary",
                "memory_type": "LongTermMemory",
                "value": "Summarized knowledge",
                "tags": ["knowledge"],
            }
        ],
        "summary": "Summary background",
    }

    with (
        patch.object(reader, "_get_llm_response", return_value=llm_response) as get_llm_response,
        patch.object(
            reader,
            "_get_maybe_merged_memory",
            side_effect=lambda extracted_memory_dict, **kwargs: extracted_memory_dict,
        ),
        patch(
            "memos.mem_reader.multi_modal_struct.trigger_hook",
            side_effect=lambda _hook, **kwargs: kwargs["items"],
        ),
    ):
        result = reader._process_string_fine(
            [fast_item],
            {"user_id": "user-1", "session_id": "session-1"},
        )

    summaries = [item for item in result if item.metadata.memory_type != "RawFileMemory"]
    rawfiles = [item for item in result if item.metadata.memory_type == "RawFileMemory"]

    assert get_llm_response.call_args.args[3] == "chat"
    assert len(summaries) == 1
    assert len(rawfiles) == 1
    assert rawfiles[0].memory == file_source.content
    assert rawfiles[0].metadata.summary_ids == [summaries[0].id]
    assert reader.multi_modal_parser.file_content_parser.create_source.call_args.kwargs[
        "message"
    ] == {"file": file_info}
