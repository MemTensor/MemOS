from __future__ import annotations

from typing import Literal

from typing_extensions import Required, TypedDict


__all__ = ["ChatCompletionContentPartVideoParam", "VideoURL"]


class VideoURL(TypedDict, total=False):
    url: Required[str]
    """A video URL or a data URL containing the encoded video."""


class ChatCompletionContentPartVideoParam(TypedDict, total=False):
    video_url: Required[VideoURL]

    type: Required[Literal["video_url"]]
    """The type of the content part."""
