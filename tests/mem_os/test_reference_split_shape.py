import pytest

from memos.mem_os.utils.reference_utils import split_continuous_references


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("[1:92ff35fb, 4:bfe6f044]", "[1:92ff35fb][4:bfe6f044]"),
        ("[1:92ff35fb,4:bfe6f044]", "[1:92ff35fb][4:bfe6f044]"),
        ("See [1:aa, 2:bb] now", "See [1:aa][2:bb] now"),
    ],
)
def test_reference_lists_are_split(text, expected):
    assert split_continuous_references(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "The set is [apple, banana] here",
        "[1, 2, 3]",
        "[some note, another note]",
        "no brackets at all",
    ],
)
def test_non_reference_text_passes_through(text):
    # plain bracketed prose used to be corrupted into [apple][banana]
    assert split_continuous_references(text) == text
