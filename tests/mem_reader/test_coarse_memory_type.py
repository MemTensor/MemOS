#!/usr/bin/env python3
"""
Rewritten test script for the updated coerce_scene_data function.

This version matches the NEW behavior:
- Local file path → parsed into text (type="text")
- Remote URL / unknown path → treated as file, with file_data
- Plain text kept as text
- Chat mode passthrough
- Fallback cases handled properly
"""

import os
import sys
import tempfile


sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from memos.mem_reader.simple_struct import coerce_scene_data


# ------------------------------------------------------------------------------
# Helper utilities
# ------------------------------------------------------------------------------


def assert_equal(actual, expected, message):
    if actual != expected:
        print("\n❌ ASSERTION FAILED")
        print(message)
        print("Expected:")
        print(expected)
        print("Actual:")
        print(actual)
        raise AssertionError(message)


def create_temp_file(content="hello world", suffix=".txt"):
    """Create a temporary local file. Returns its path and content."""
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    return path, content


# ------------------------------------------------------------------------------
# Tests begin
# ------------------------------------------------------------------------------


def test_empty_inputs():
    result = coerce_scene_data([], "chat")
    assert_equal(result, [], "Empty input should return empty list")


def test_chat_passthrough():
    result = coerce_scene_data(["hello"], "chat")
    assert_equal(result, ["hello"], "Chat mode should passthrough list[str]")

    msg_list = [{"role": "user", "content": "hi"}]
    result = coerce_scene_data([msg_list], "chat")
    assert_equal(result, [msg_list], "Chat mode should passthrough MessageList")


def test_doc_local_file():
    local_path, content = create_temp_file("test local file content")
    result = coerce_scene_data([local_path], "doc")

    filename = os.path.basename(local_path)
    expected = [
        [
            {
                "type": "file",
                "file": {
                    "filename": filename,
                    "file_data": "test local file content",
                },
            }
        ]
    ]
    assert_equal(result, expected, "Local file should be wrapped as file with parsed text")


def test_doc_remote_url():
    url = "https://example.com/file.pdf"
    result = coerce_scene_data([url], "doc")

    filename = "file.pdf"
    expected = [[{"type": "file", "file": {"filename": filename, "file_data": url}}]]
    assert_equal(result, expected, "Remote URL should be treated as file_data string")


def test_doc_unknown_path():
    path = "/nonexistent/path/file.docx"
    result = coerce_scene_data([path], "doc")

    expected = [[{"type": "file", "file": {"filename": "file.docx", "file_data": path}}]]
    assert_equal(result, expected, "Unknown path should be treated as file_data")


def test_doc_plain_text():
    text = "this is plain text"
    result = coerce_scene_data([text], "doc")

    expected = [[{"type": "text", "text": "this is plain text"}]]
    assert_equal(result, expected, "Plain text should produce text content")


def test_doc_mixed():
    local_path, content = create_temp_file("local file content")
    url = "https://example.com/x.pdf"
    plain = "hello world"

    result = coerce_scene_data([plain, local_path, url], "doc")

    filename = os.path.basename(local_path)
    expected = [
        [{"type": "text", "text": plain}],
        [
            {
                "type": "file",
                "file": {
                    "filename": filename,
                    "file_data": "local file content",
                },
            }
        ],
        [
            {
                "type": "file",
                "file": {
                    "filename": "x.pdf",
                    "file_data": url,
                },
            }
        ],
    ]
    assert_equal(result, expected, "Mixed doc inputs should be normalized correctly")


def test_fallback():
    result = coerce_scene_data([123], "chat")
    expected = ["[123]"]
    assert_equal(result, expected, "Unexpected input should fallback to str(scene_data)")


# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------


def main():
    print("\n========================================")
    print("Running NEW tests for coerce_scene_data")
    print("========================================")

    test_empty_inputs()
    test_chat_passthrough()
    test_doc_local_file()
    test_doc_remote_url()
    test_doc_unknown_path()
    test_doc_plain_text()
    test_doc_mixed()
    test_fallback()

    print("\n========================================")
    print("✅ All tests passed!")
    print("========================================")


if __name__ == "__main__":
    main()
