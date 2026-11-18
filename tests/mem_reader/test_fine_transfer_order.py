"""Fine-transfer groups retain their input index when tasks finish out of order."""

from types import SimpleNamespace

import pytest

from memos.mem_reader.simple_struct import SimpleStructMemReader


@pytest.mark.parametrize("failed_result", [None, ValueError("synthetic failure")])
def test_fine_transfer_keeps_failed_slots_and_input_order(monkeypatch, failed_result):
    monkeypatch.setattr(
        "memos.mem_reader.simple_struct.concurrent.futures.as_completed",
        lambda futures: iter(reversed(list(futures))),
    )

    def process(source, custom_tags, **kwargs):
        if source == "missing":
            if isinstance(failed_result, Exception):
                raise failed_result
            return failed_result
        return [source + "-enhanced"]

    reader = SimpleNamespace(_process_transfer_chat_data=process)
    result = SimpleStructMemReader.fine_transfer_simple_mem(
        reader, ["first", "missing", "last"], "chat"
    )
    assert result == [["first-enhanced"], [], ["last-enhanced"]]


def test_multimodal_fine_transfer_returns_one_group_for_the_batch():
    from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader

    sources = ["first", "last"]
    enhanced = ["combined-enhanced"]

    def process(memories, custom_tags, **kwargs):
        assert memories is sources
        return enhanced

    reader = SimpleNamespace(_process_transfer_multi_modal_data=process)
    result = MultiModalStructMemReader.fine_transfer_simple_mem(reader, sources, "chat")
    assert result == [enhanced]
    assert result[0] is enhanced
