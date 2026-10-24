"""Tests for vision image URL validation in ImageParser.parse_fine."""

import json

from unittest.mock import MagicMock

import pytest

from memos.mem_reader.read_multi_modal.image_parser import ImageParser


def _parser() -> tuple[ImageParser, MagicMock]:
    llm = MagicMock()
    llm.generate.return_value = json.dumps(
        {
            "memory list": [
                {
                    "key": "visible label",
                    "memory_type": "LongTermMemory",
                    "value": "A product label is visible.",
                    "tags": ["image"],
                }
            ],
            "summary": "A labeled product.",
        }
    )
    embedder = MagicMock()
    embedder.embed.return_value = [[0.1, 0.2]]
    return ImageParser(embedder, llm), llm


def _image_message(url: str) -> dict:
    return {"type": "image_url", "image_url": {"url": url, "detail": "auto"}}


INFO = {"user_id": "user-1", "session_id": "session-1"}


@pytest.mark.parametrize(
    "url",
    [
        "images/c502e59b213998cd695d7f57a6e33de73f5493f2d3fbab6c4e9635341aa7e7b7.jpg",
        "image/photo.png",
        "/tmp/photo.jpg",
        "file:///tmp/photo.jpg",
        "data:images/jpeg;base64,aaaa",
        "data:image/jpeg,not-base64",
    ],
)
def test_parse_fine_skips_non_sendable_image_url(url: str) -> None:
    parser, llm = _parser()

    result = parser.parse_fine(_image_message(url), INFO)

    assert result == []
    llm.generate.assert_not_called()


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/device.jpg",
        "http://example.com/images/device.jpg",
        "data:image/jpeg;base64,aaaa",
        "DATA:IMAGE/PNG;base64,bbbb",
    ],
)
def test_parse_fine_sends_http_and_base64_image_urls(url: str) -> None:
    parser, llm = _parser()

    result = parser.parse_fine(_image_message(url), INFO)

    assert len(result) == 1
    llm.generate.assert_called_once()
    sent_url = llm.generate.call_args.args[0][0]["content"][1]["image_url"]["url"]
    assert sent_url == url
