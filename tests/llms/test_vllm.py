import unittest

from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.configs.llm import VLLMLLMConfig
from memos.llms.vllm import VLLMLLM


class TestVLLMLLMGenerateStream(unittest.TestCase):
    def setUp(self):
        config = VLLMLLMConfig(
            model_name_or_path="test-model",
            api_key="test-key",
            remove_think_prefix=False,
        )
        self.llm = VLLMLLM(config)
        self.messages = [{"role": "user", "content": "Think, then answer"}]

    @staticmethod
    def make_chunk(**delta_fields):
        delta = SimpleNamespace(**delta_fields)
        return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])

    def generate_chunks(self, stream_chunks):
        self.llm.client.chat.completions.create = MagicMock(return_value=iter(stream_chunks))
        return list(self.llm.generate_stream(self.messages))

    def test_yields_every_content_chunk_after_reasoning(self):
        stream_chunks = [
            self.make_chunk(reasoning="Considering..."),
            self.make_chunk(content="Hello"),
            self.make_chunk(content=", "),
            self.make_chunk(content="world!"),
        ]

        self.assertEqual(
            self.generate_chunks(stream_chunks),
            ["<think>", "Considering...", "</think>", "Hello", ", ", "world!"],
        )

    def test_empty_or_choiceless_stream_returns_no_chunks(self):
        streams = {
            "empty": [],
            "choices_empty": [SimpleNamespace(choices=[])],
        }

        for name, stream_chunks in streams.items():
            with self.subTest(name=name):
                self.assertEqual(self.generate_chunks(stream_chunks), [])

    def test_reasoning_only_stream_closes_think_block(self):
        stream_chunks = [
            self.make_chunk(reasoning="First thought. "),
            self.make_chunk(reasoning="Second thought."),
        ]

        self.assertEqual(
            self.generate_chunks(stream_chunks),
            ["<think>", "First thought. ", "Second thought.", "</think>"],
        )

    def test_remove_think_prefix_omits_tags(self):
        self.llm.config.remove_think_prefix = True
        streams = {
            "reasoning_then_content": (
                [self.make_chunk(reasoning="Thinking."), self.make_chunk(content="Answer")],
                ["Thinking.", "Answer"],
            ),
            "reasoning_only": (
                [self.make_chunk(reasoning="Thinking.")],
                ["Thinking."],
            ),
        }

        for name, (stream_chunks, expected) in streams.items():
            with self.subTest(name=name):
                self.assertEqual(self.generate_chunks(stream_chunks), expected)
