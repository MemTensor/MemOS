import uuid

from unittest.mock import Mock

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


def make_raw(item_id: str, relativity: float, **extra) -> TextualMemoryItem:
    return TextualMemoryItem(
        id=item_id,
        memory=item_id,
        metadata=TreeNodeTextualMemoryMetadata(
            memory_type="RawFileMemory",
            relativity=relativity,
            **extra,
        ),
    )


def test_postformat_discovers_rawfile_neighbors_by_id_without_edges():
    import memos.api.handlers  # noqa: F401 - initialize package before known circular import

    from memos.multi_mem_cube.single_cube import SingleCubeView

    previous = make_raw(str(uuid.uuid4()), 0.1)
    following = make_raw(str(uuid.uuid4()), 0.1)
    current = make_raw(str(uuid.uuid4()), 1.0, preceding_id=previous.id, following_id=following.id)
    searcher = Mock()
    neighbors = {
        previous.id: previous.model_dump(),
        following.id: following.model_dump(),
    }
    searcher.graph_store.get_node.side_effect = lambda node_id, **_: neighbors.get(node_id)
    view = SingleCubeView(
        cube_id="cube-1",
        naive_mem_cube=Mock(),
        mem_reader=Mock(),
        mem_scheduler=Mock(),
        logger=Mock(),
        searcher=searcher,
    )

    result = view._postformat_memories(
        [current], "cube-1", include_embedding=False, neighbor_discovery=True
    )

    assert [item["id"] for item in result] == [previous.id, current.id, following.id]
    assert result[0]["metadata"]["relativity"] == 0.8
    assert result[2]["metadata"]["relativity"] == 0.8
    searcher.graph_store.get_edges.assert_not_called()
