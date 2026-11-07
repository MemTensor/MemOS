"""Strict restore and atomic publication of Tree backup files."""

import json

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import memos.memories.textual.tree as module

from memos.exceptions import GraphDBError, MemCubeError, MemoryError
from memos.graph_dbs.opengauss import OpenGaussGraphDB
from memos.mem_cube.general import GeneralMemCube
from memos.memories.textual.tree import TreeTextMemory


@pytest.fixture
def memory():
    memory = TreeTextMemory.__new__(TreeTextMemory)
    memory.config = SimpleNamespace(memory_filename="memory.json")
    memory.graph_store = Mock(spec=OpenGaussGraphDB)
    memory.graph_store.export_graph.return_value = {"nodes": [{"id": "中文"}], "edges": []}
    return memory


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("include", [False, True])
def test_dump_projection_and_load(memory, tmp_path, legacy, include):
    if legacy:
        memory.graph_store = Mock()
        memory.graph_store.export_graph.return_value = {"nodes": [], "edges": []}
    memory.dump(str(tmp_path), include_embedding=include, user_name="A")
    kwargs = {"include_embedding": include, "user_name": "A"}
    if not legacy:
        kwargs["status"] = []
    memory.graph_store.export_graph.assert_called_once_with(**kwargs)
    data = json.loads((tmp_path / "memory.json").read_text())
    assert data == memory.graph_store.export_graph.return_value
    memory.load(str(tmp_path), user_name="A")
    memory.graph_store.import_graph.assert_called_once_with(data, user_name="A")
    assert [p.name for p in tmp_path.iterdir()] == ["memory.json"]


@pytest.mark.parametrize(
    "content,cause",
    [(None, FileNotFoundError), (b"{", json.JSONDecodeError), (b"\xff", UnicodeDecodeError)],
)
@pytest.mark.parametrize("legacy", [False, True])
def test_load_file_failures_visible(memory, tmp_path, content, cause, legacy):
    if legacy:
        memory.graph_store = Mock()
    if content is not None:
        (tmp_path / "memory.json").write_bytes(content)
    with pytest.raises(MemoryError) as error:
        memory.load(str(tmp_path))
    assert isinstance(error.value.__cause__, cause)
    memory.graph_store.import_graph.assert_not_called()


def test_load_io_failure(memory, tmp_path, monkeypatch):
    failure = PermissionError("read denied")
    monkeypatch.setattr("builtins.open", Mock(side_effect=failure))
    with pytest.raises(MemoryError) as error:
        memory.load(str(tmp_path))
    assert error.value.__cause__ is failure


@pytest.mark.parametrize("operation", ["dump", "load"])
@pytest.mark.parametrize("failure", [GraphDBError("storage"), ValueError("invalid graph")])
def test_storage_errors_preserve_identity_and_cause(memory, tmp_path, operation, failure):
    failure.__cause__ = OSError("original storage error")
    (tmp_path / "memory.json").write_text('{"nodes": [], "edges": []}')
    getattr(
        memory.graph_store, "export_graph" if operation == "dump" else "import_graph"
    ).side_effect = failure
    before = (tmp_path / "memory.json").read_bytes()
    with pytest.raises(type(failure)) as error:
        getattr(memory, operation)(str(tmp_path))
    assert error.value is failure and error.value.__cause__.args == ("original storage error",)
    assert (tmp_path / "memory.json").read_bytes() == before
    assert len(list(tmp_path.iterdir())) == 1


@pytest.mark.parametrize(
    "stage", ["mkdir", "create", "serialize", "write", "flush", "fsync", "close", "replace"]
)
def test_atomic_failure_preserves_old_file_and_cleans_temp(memory, tmp_path, monkeypatch, stage):
    target = tmp_path / "memory.json"
    target.write_bytes(b"previous backup")
    failure = TypeError("serialize") if stage == "serialize" else OSError(stage)
    if stage == "mkdir":
        monkeypatch.setattr(module.os, "makedirs", Mock(side_effect=failure))
    elif stage == "create":
        monkeypatch.setattr(module.tempfile, "NamedTemporaryFile", Mock(side_effect=failure))
    elif stage == "serialize":
        monkeypatch.setattr(module.json, "dump", Mock(side_effect=failure))
    elif stage in ("fsync", "replace"):
        monkeypatch.setattr(module.os, stage, Mock(side_effect=failure))
    else:
        create = module.tempfile.NamedTemporaryFile

        def failing_file(*args, **kwargs):
            raw = create(*args, **kwargs)

            class File:
                name = raw.name

                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    raw.close()
                    if stage == "close":
                        raise failure

                def write(self, data):
                    if stage == "write":
                        raise failure
                    return raw.write(data)

                def flush(self):
                    if stage == "flush":
                        raise failure
                    return raw.flush()

                def fileno(self):
                    return raw.fileno()

            return File()

        monkeypatch.setattr(module.tempfile, "NamedTemporaryFile", failing_file)
    with pytest.raises(MemoryError) as error:
        memory.dump(str(tmp_path))
    assert error.value.__cause__ is failure
    assert target.read_bytes() == b"previous backup"
    assert [p.name for p in tmp_path.iterdir()] == ["memory.json"]


def test_atomic_publication_occurs_after_closed_complete_file(memory, tmp_path, monkeypatch):
    replace = module.os.replace
    calls = []
    sync = module.os.fsync

    def observed_sync(fd):
        calls.append("fsync")
        return sync(fd)

    def observed_replace(source, destination):
        assert calls == ["fsync"]
        assert (
            json.loads(module.Path(source).read_text())
            == memory.graph_store.export_graph.return_value
        )
        calls.append("replace")
        return replace(source, destination)

    monkeypatch.setattr(module.os, "fsync", observed_sync)
    monkeypatch.setattr(module.os, "replace", observed_replace)
    memory.dump(str(tmp_path))
    assert calls == ["fsync", "replace"]


@pytest.mark.parametrize(
    "cleanup_error", [FileNotFoundError("gone"), PermissionError("cleanup denied")]
)
def test_cleanup_failure_does_not_mask_primary(memory, tmp_path, monkeypatch, cleanup_error):
    primary = OSError("replace")
    monkeypatch.setattr(module.os, "replace", Mock(side_effect=primary))
    unlink = module.os.unlink

    def failed_unlink(path):
        unlink(path)
        raise cleanup_error

    monkeypatch.setattr(module.os, "unlink", failed_unlink)
    with pytest.raises(MemoryError) as error:
        memory.dump(str(tmp_path))
    assert error.value.__cause__ is primary


@pytest.mark.parametrize("kind", ["opengauss", "other_tree", "other_memory", "none"])
@pytest.mark.parametrize("selection", [None, [], ["text_mem", "act_mem", "para_mem", "pref_mem"]])
def test_cube_dump_selection_and_embedding(memory, tmp_path, kind, selection):
    cube = GeneralMemCube.__new__(GeneralMemCube)
    cube.config = Mock(config_filename="config.json")
    if kind == "none":
        cube._text_mem = None
    elif kind == "other_memory":
        cube._text_mem = Mock()
    else:
        memory.dump = Mock()
        if kind == "other_tree":
            memory.graph_store = Mock()
        cube._text_mem = memory
    cube._act_mem, cube._para_mem, cube._pref_mem = (Mock() for _ in range(3))
    cube.dump(str(tmp_path), memory_types=selection)
    for name in ("text_mem", "act_mem", "para_mem", "pref_mem"):
        component = getattr(cube, name)
        if component is None:
            continue
        if selection == []:
            component.dump.assert_not_called()
        else:
            kwargs = (
                {"include_embedding": True} if name == "text_mem" and kind == "opengauss" else {}
            )
            component.dump.assert_called_once_with(str(tmp_path), **kwargs)


def test_cube_empty_memories_and_directory_guard(tmp_path):
    cube = GeneralMemCube.__new__(GeneralMemCube)
    cube.config = Mock(config_filename="config.json")
    cube._text_mem = cube._act_mem = cube._para_mem = cube._pref_mem = None
    cube.dump(str(tmp_path / "new"))
    (tmp_path / "occupied").touch()
    with pytest.raises(MemCubeError):
        cube.dump(str(tmp_path))
