from memos.mem_os.utils.reference_utils import prepare_reference_data


def test_textual_item_still_gets_ref_id():
    from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata

    item = TextualMemoryItem(
        memory="hello world",
        metadata=TextualMemoryMetadata(user_id="u1"),
    )
    (reference,) = prepare_reference_data([item])
    assert reference["metadata"]["ref_id"] == str(item.id).split("-")[0]
    assert reference["metadata"]["memory"] == "hello world"


def test_dict_entry_with_string_id():
    (reference,) = prepare_reference_data(
        [{"id": "92ff35fb-1234", "memory": "m", "metadata": {}}]
    )
    assert reference["metadata"]["ref_id"] == "92ff35fb"
    assert reference["metadata"]["id"] == "92ff35fb-1234"


def test_dict_entry_with_int_id():
    # an int id used to crash with AttributeError: 'int' object has no
    # attribute 'split'
    (reference,) = prepare_reference_data([{"id": 12345, "memory": "m", "metadata": {}}])
    assert reference["metadata"]["ref_id"] == "12345"


def test_dict_entry_without_id():
    # a missing id used to crash with KeyError: 'id'
    (reference,) = prepare_reference_data([{"memory": "m", "metadata": {}}])
    assert reference["metadata"]["memory"] == "m"
    assert "ref_id" not in reference["metadata"]
