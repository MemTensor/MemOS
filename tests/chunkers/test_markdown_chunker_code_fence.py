import unittest

from unittest.mock import patch

from memos.chunkers.markdown_chunker import MarkdownChunker


class TestMarkdownChunkerCodeFence(unittest.TestCase):
    """Fenced code blocks must never be treated as markdown headers.

    ``#``-comment lines inside embedded code (```python blocks, shell
    scripts, ...) used to be counted as level-1 headers by
    ``_detect_malformed_headers``; enough of them triggered the
    "malformed hierarchy" repair, and ``_fix_header_hierarchy`` rewrote the
    comments into ``## ...`` lines inside the code block, corrupting it.
    """

    def _chunker(self) -> MarkdownChunker:
        with patch("langchain_text_splitters.MarkdownHeaderTextSplitter"):
            return MarkdownChunker(config=None, auto_fix_headers=True)

    def test_code_block_only_has_no_headers(self):
        text = "```python\n# one\n# two\n# three\n# four\n# five\nx = 1\n```\n"
        chunker = self._chunker()

        self.assertFalse(chunker._detect_malformed_headers(text))

    def test_fix_leaves_code_block_intact(self):
        text = (
            "# Title\n\n"
            "Intro.\n\n"
            "```python\n"
            "# comment one\n"
            "# comment two\n"
            "# comment three\n"
            "# comment four\n"
            "# comment five\n"
            "x = 1\n"
            "```\n"
        )
        chunker = self._chunker()

        # the fixer must leave fenced code byte-for-byte intact
        self.assertEqual(chunker._fix_header_hierarchy(text), text)

    def test_real_malformed_headers_still_fixed(self):
        text = "# A\n# B\n# C\nbody\n"
        chunker = self._chunker()

        self.assertTrue(chunker._detect_malformed_headers(text))
        fixed = chunker._fix_header_hierarchy(text)
        self.assertIn("# A\n", fixed)
        self.assertIn("## B\n", fixed)
        self.assertIn("## C\n", fixed)

    def test_tilde_fence_ignored_and_real_headers_fixed(self):
        text = "~~~\n# not a header\n~~~\n\n# Real One\n# Real Two\n"
        chunker = self._chunker()

        # only the two real headers are counted, which is malformed
        self.assertTrue(chunker._detect_malformed_headers(text))
        fixed = chunker._fix_header_hierarchy(text)
        self.assertIn("~~~\n# not a header\n~~~", fixed)
        self.assertIn("# Real One\n", fixed)
        self.assertIn("## Real Two\n", fixed)

    def test_unclosed_fence_holds_to_end(self):
        text = "```python\n# one\n# two\n# three\n# four\n# five\n"
        chunker = self._chunker()

        self.assertFalse(chunker._detect_malformed_headers(text))
        self.assertEqual(chunker._fix_header_hierarchy(text), text)


if __name__ == "__main__":
    unittest.main()
