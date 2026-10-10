import uuid

from unittest.mock import Mock

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree import TreeTextMemory


class FakeGraphStore:
    def __init__(self, items: list[TextualMemoryItem]) -> None:
        self.nodes = {item.id: item.model_dump() for item in items}
        self.edge_calls: list[tuple] = []
        self.deleted_by_params: list[dict] = []

    def get_nodes(self, ids, user_name=None):
        return [self.nodes[node_id] for node_id in ids if node_id in self.nodes]

    def update_node(self, id, fields, user_name=None):
        self.nodes[id]["metadata"].update(fields)

    def delete_node(self, id, user_name=None):
        self.nodes.pop(id, None)

    def delete_node_by_prams(self, **kwargs):
        self.deleted_by_params.append(kwargs)
        for node_id in kwargs.get("memory_ids") or []:
            self.nodes.pop(node_id, None)

    def get_by_metadata(self, filters, user_name=None, status=None):
        matched = []
        for node_id, node in self.nodes.items():
            metadata = node["metadata"]
            if all(
                (
                    item["value"] in (metadata.get(item["field"]) or [])
                    if item.get("op") == "contains"
                    else metadata.get(item["field"]) == item["value"]
                )
                for item in filters
            ):
                matched.append(node_id)
        return matched

    def add_edge(self, *args, **kwargs):
        self.edge_calls.append((args, kwargs))

    def get_edges(self, *args, **kwargs):
        self.edge_calls.append((args, kwargs))
        return []


def _test_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, value))


def make_item(
    item_id: str,
    memory_type: str,
    *,
    knowledge_material_ids: list[str] | None = None,
    knowledge_summary_ids: list[str] | None = None,
    info: dict | None = None,
    file_ids: list[str] | None = None,
    summary_ids: list[str] | None = None,
) -> TextualMemoryItem:
    metadata = TreeNodeTextualMemoryMetadata(
        memory_type=memory_type,
        knowledge_material_ids=[_test_id(value) for value in knowledge_material_ids or []],
        knowledge_summary_ids=[_test_id(value) for value in knowledge_summary_ids or []],
        info=(
            {
                **info,
                "merged_from": [_test_id(value) for value in info.get("merged_from", [])],
            }
            if info and "merged_from" in info
            else info
        ),
        file_ids=file_ids or [],
    )
    if summary_ids is not None:
        metadata.summary_ids = [_test_id(value) for value in summary_ids]
    return TextualMemoryItem(id=_test_id(item_id), memory=item_id, metadata=metadata)


def make_tree(items: list[TextualMemoryItem]) -> tuple[TreeTextMemory, FakeGraphStore]:
    tree = TreeTextMemory.__new__(TreeTextMemory)
    graph_store = FakeGraphStore(items)
    tree.graph_store = graph_store

    def add(memories, user_name=None, **kwargs):
        for memory in memories:
            graph_store.nodes[memory.id] = memory.model_dump()
        return [memory.id for memory in memories]

    tree.add = Mock(side_effect=add)
    return tree, graph_store


def test_add_rawfile_nodes_persists_bidirectional_ids_without_edges():
    summary = make_item("summary-1", "LongTermMemory")
    material = make_item("material-1", "RawFileMemory", summary_ids=[summary.id])
    tree, graph_store = make_tree([summary])

    tree.add_rawfile_nodes([material], [summary.id], user_name="cube-1")

    assert graph_store.nodes[material.id]["metadata"]["knowledge_summary_ids"] == [summary.id]
    assert graph_store.nodes[summary.id]["metadata"]["knowledge_material_ids"] == [material.id]
    assert graph_store.edge_calls == []


def test_add_rawfile_nodes_reconnects_materials_when_summary_is_merged():
    old_material = make_item("material-old", "RawFileMemory", knowledge_summary_ids=["summary-old"])
    old_summary = make_item(
        "summary-old", "LongTermMemory", knowledge_material_ids=[old_material.id]
    )
    new_summary = make_item("summary-new", "LongTermMemory", info={"merged_from": [old_summary.id]})
    new_material = make_item("material-new", "RawFileMemory", summary_ids=[new_summary.id])
    tree, graph_store = make_tree([old_material, old_summary, new_summary])

    tree.add_rawfile_nodes([new_material], [new_summary.id], user_name="cube-1")

    assert graph_store.nodes[new_summary.id]["metadata"]["knowledge_material_ids"] == [
        new_material.id,
        old_material.id,
    ]
    assert graph_store.nodes[old_material.id]["metadata"]["knowledge_summary_ids"] == [
        new_summary.id
    ]


def test_delete_summary_unlinks_material_without_deleting_it():
    material = make_item("material-1", "RawFileMemory", knowledge_summary_ids=["summary-1"])
    summary = make_item("summary-1", "LongTermMemory", knowledge_material_ids=[material.id])
    tree, graph_store = make_tree([material, summary])

    tree.delete_by_memory_ids([summary.id])

    assert summary.id not in graph_store.nodes
    assert graph_store.nodes[material.id]["metadata"]["knowledge_summary_ids"] == []


def test_delete_material_unlinks_summary_without_deleting_it():
    material = make_item("material-1", "RawFileMemory", knowledge_summary_ids=["summary-1"])
    summary = make_item("summary-1", "LongTermMemory", knowledge_material_ids=[material.id])
    tree, graph_store = make_tree([material, summary])

    tree.delete_by_memory_ids([material.id])

    assert material.id not in graph_store.nodes
    assert graph_store.nodes[summary.id]["metadata"]["knowledge_material_ids"] == []


def test_file_delete_unlinks_knowledge_relations_before_bulk_delete():
    material = make_item(
        "material-1",
        "RawFileMemory",
        knowledge_summary_ids=["summary-1"],
        file_ids=["file-1"],
    )
    summary = make_item("summary-1", "LongTermMemory", knowledge_material_ids=[material.id])
    tree, graph_store = make_tree([material, summary])

    tree.delete_by_filter(writable_cube_ids=["cube-1"], file_ids=["file-1"])

    assert graph_store.nodes[summary.id]["metadata"]["knowledge_material_ids"] == []
    assert graph_store.deleted_by_params == [
        {"writable_cube_ids": ["cube-1"], "file_ids": ["file-1"], "filter": None}
    ]


def test_soft_delete_unlinks_summary_before_marking_it_deleted():
    material = make_item("material-1", "RawFileMemory", knowledge_summary_ids=["summary-1"])
    summary = make_item("summary-1", "LongTermMemory", knowledge_material_ids=[material.id])
    tree, graph_store = make_tree([material, summary])

    tree.soft_delete([summary.id], user_name="cube-1")

    assert graph_store.nodes[material.id]["metadata"]["knowledge_summary_ids"] == []
    assert graph_store.nodes[summary.id]["metadata"]["status"] == "deleted"
