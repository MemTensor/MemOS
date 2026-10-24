"""Regression tests for video content validation and memory provenance."""

from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from pydantic import TypeAdapter, ValidationError

from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.read_multi_modal.user_parser import UserParser
from memos.memories.textual.item import SourceMessage
from memos.types.openai_chat_completion_types import ChatCompletionUserMessageParam


@pytest.mark.parametrize("url", ["https://example.com/clip.mp4", "data:video/mp4;base64,AAAA"])
def test_video_content_survives_chat_validation(url):
    message = {
        "role": "user",
        "content": [{"type": "video_url", "video_url": {"url": url}}],
    }

    assert TypeAdapter(ChatCompletionUserMessageParam).validate_python(message) == message


def test_video_content_requires_a_url():
    message = {"role": "user", "content": [{"type": "video_url", "video_url": {}}]}

    with pytest.raises(ValidationError):
        TypeAdapter(ChatCompletionUserMessageParam).validate_python(message)


def test_video_source_survives_message_expansion_and_serialization():
    video = {"type": "video_url", "video_url": {"url": "https://example.com/clip.mp4"}}
    message = {
        "role": "user",
        "content": [{"type": "text", "text": "Remember this clip"}, video],
        "chat_time": "2026-10-01T00:00:00Z",
        "message_id": "video-message",
    }
    original = deepcopy(message)
    expanded = MultiModalStructMemReader._expand_multimodal_messages([message])
    video_messages = [item for item in expanded if isinstance(item.get("content"), list)]

    assert len(video_messages) == 1
    assert video_messages[0] == {**message, "content": [video]}
    assert message == original
    assert any(item.get("content") == "Remember this clip" for item in expanded)

    parser = UserParser(embedder=MagicMock())
    memories = parser.parse_fast(video_messages[0], {}, need_emb=False)
    assert len(memories) == 1
    source = SourceMessage.model_validate(memories[0].metadata.sources[0].model_dump())
    assert source.type == "video"
    assert source.video_info == video["video_url"]
    assert source.content == video["video_url"]["url"]
    assert source.message_id == message["message_id"]
    assert source.chat_time == message["chat_time"]
    assert source.role == "user"


def test_video_only_message_is_not_replaced_by_a_placeholder():
    message = {
        "role": "user",
        "content": [{"type": "video_url", "video_url": {"url": "https://example.com/clip.mp4"}}],
    }

    assert MultiModalStructMemReader._expand_multimodal_messages([message]) == [message]


def test_existing_text_and_image_expansion_is_unchanged():
    image = {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}
    message = {"role": "user", "content": [{"type": "text", "text": "A picture"}, image]}

    assert MultiModalStructMemReader._expand_multimodal_messages([message]) == [
        image,
        {"role": "user", "content": "A picture"},
    ]
