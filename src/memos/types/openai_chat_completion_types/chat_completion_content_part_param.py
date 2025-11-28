from __future__ import annotations

from typing import Literal, TypeAlias

from typing_extensions import Required, TypedDict

from .chat_completion_content_part_image_param import ChatCompletionContentPartImageParam
from .chat_completion_content_part_input_audio_param import ChatCompletionContentPartInputAudioParam
from .chat_completion_content_part_text_param import ChatCompletionContentPartTextParam


__all__ = ["ChatCompletionContentPartParam", "File", "FileFile"]


class FileFile(TypedDict, total=False):
    file_data: str
    """
    The base64 encoded file data, used when passing the file to the model as a
    string.
    or a url.
    or just string which is the content of the file.
    """

    file_id: str
    """The ID of an uploaded file to use as input."""

    filename: str
    """The name of the file, used when passing the file to the model as a string."""


class File(TypedDict, total=False):
    file: Required[FileFile]

    type: Required[Literal["file"]]
    """The type of the content part. Always `file`."""


ChatCompletionContentPartParam: TypeAlias = (
    ChatCompletionContentPartTextParam
    | ChatCompletionContentPartImageParam
    | ChatCompletionContentPartInputAudioParam
    | File
)
