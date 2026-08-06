from unittest.mock import MagicMock, patch

from memos.mem_reader.read_multi_modal.file_content_parser import FileContentParser
from memos.mem_reader.read_multi_modal.multi_modal_parser import MultiModalParser
from memos.templates.mem_reader_prompts import (
    SIMPLE_STRUCT_DOC_READER_PROMPT,
    SIMPLE_STRUCT_DOC_READER_PROMPT_ZH,
)


def test_url_path_markdown_suffix_overrides_original_filename():
    parser = FileContentParser(
        embedder=MagicMock(),
        llm=MagicMock(),
        direct_markdown_hostnames=[],
    )
    response = MagicMock()
    response.text = "# parsed markdown"
    response.content = b"# parsed markdown"

    with (
        patch("requests.get", return_value=response),
        patch(
            "tempfile.NamedTemporaryFile",
            side_effect=AssertionError("markdown URL should not be written to a temp file"),
        ),
    ):
        text, temp_path, is_markdown = parser._handle_url(
            "https://memos.example/api/download/document.md?signature=secret",
            "original-document.docx",
        )

    assert text == "# parsed markdown"
    assert temp_path is None
    assert is_markdown is True


def test_multi_modal_parser_routes_files_to_dedicated_document_llm():
    main_llm = MagicMock(name="main_llm")
    document_llm = MagicMock(name="document_llm")

    parser = MultiModalParser(
        embedder=MagicMock(),
        llm=main_llm,
        document_parser_llm=document_llm,
    )

    assert parser.string_parser.llm is main_llm
    assert parser.file_content_parser.llm is document_llm


def test_multi_modal_parser_does_not_fall_back_files_to_main_llm():
    main_llm = MagicMock(name="main_llm")

    parser = MultiModalParser(
        embedder=MagicMock(),
        llm=main_llm,
        document_parser_llm=None,
    )

    assert parser.string_parser.llm is main_llm
    assert parser.file_content_parser.llm is None


def test_document_prompts_use_complete_records_without_over_splitting():
    assert "smallest complete record" in SIMPLE_STRUCT_DOC_READER_PROMPT
    assert "Preserve every row" in SIMPLE_STRUCT_DOC_READER_PROMPT
    assert "Do not split one row into separate memories" in SIMPLE_STRUCT_DOC_READER_PROMPT
    assert "Keep a simple list of peer items together" in SIMPLE_STRUCT_DOC_READER_PROMPT
    assert "Never replace exact values" in SIMPLE_STRUCT_DOC_READER_PROMPT

    assert "最小完整记录" in SIMPLE_STRUCT_DOC_READER_PROMPT_ZH
    assert "完整保留每一行" in SIMPLE_STRUCT_DOC_READER_PROMPT_ZH
    assert "不得把同一行拆成多条记忆" in SIMPLE_STRUCT_DOC_READER_PROMPT_ZH
    assert "普通并列列表应按共同主题合并" in SIMPLE_STRUCT_DOC_READER_PROMPT_ZH
    assert "不得用模糊概述替代精确数值" in SIMPLE_STRUCT_DOC_READER_PROMPT_ZH


def test_markdown_h1_titles_are_passed_as_document_context():
    embedder = MagicMock()
    embedder.embed.return_value = [[0.1]]
    parser = FileContentParser(
        embedder=embedder,
        llm=MagicMock(),
        parser=MagicMock(),
        direct_markdown_hostnames=[],
    )
    markdown = """# *2026 PPA 北京公开赛内部培训资料*

## 非全局子标题

# 04 报名时间

即日起至 5 月 29 日 24:00
"""
    parser._handle_url = MagicMock(return_value=(markdown, None, True))
    parser._split_text = MagicMock(return_value=["# 04 报名时间\n即日起至 5 月 29 日 24:00"])
    parser._get_doc_llm_response = MagicMock(
        return_value={
            "memory list": [
                {
                    "key": "报名截止时间",
                    "memory_type": "LongTermMemory",
                    "value": "报名截止时间为2026年5月29日24:00。",
                    "tags": ["报名", "时间"],
                }
            ],
            "summary": "报名截止时间",
        }
    )

    parser.parse_fine(
        {
            "type": "file",
            "file": {
                "file_data": "https://example.com/document.md",
                "file_id": "file-1",
                "filename": "training.docx",
            },
        },
        {"user_id": "user-1", "session_id": "session-1"},
    )

    context = parser._get_doc_llm_response.call_args.kwargs["message_text_context"]
    assert "training.docx" in context
    assert "*2026 PPA 北京公开赛内部培训资料*" in context
    assert "04 报名时间" in context
    assert "非全局子标题" not in context
