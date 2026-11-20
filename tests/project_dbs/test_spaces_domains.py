"""Contract tests for space and domain methods; run on every backend."""

import uuid

import pytest

from memos.project_dbs.exceptions import (
    DomainAlreadyExistsError,
    DomainInUseError,
    DomainLimitExceededError,
    DomainNotFoundError,
    SpaceNotFoundError,
)
from memos.project_dbs.item import Domain, DomainUpdate
from tests.project_dbs.conftest import add_topic


@pytest.fixture
def project():
    return f"project_{uuid.uuid4().hex}"


def names(domains):
    return [d.domain for d in domains]


# ---------- spaces ----------
def test_create_space_with_initial_domains(db, project):
    space = db.create_space(
        project,
        "Memmy 开发",
        domains=[Domain(domain="开发", description="实现"), Domain(domain="运维")],
    )
    assert uuid.UUID(space.id)
    assert (space.project_id, space.space_name, space.instructions) == (project, "Memmy 开发", None)
    assert space.create_time == space.update_time and space.create_time.tzinfo is not None
    domains = db.list_domains(space.id)
    assert {d.domain: d.description for d in domains} == {"开发": "实现", "运维": ""}
    assert all(d.id and d.space_id == space.id for d in domains)


def test_create_space_same_name_gets_new_id(db, project):
    assert db.create_space(project, "同名").id != db.create_space(project, "同名").id


def test_create_space_rolls_back_when_too_many_domains(db, project):
    with pytest.raises(DomainLimitExceededError):
        db.create_space(project, "s", domains=[Domain(domain=f"d{i}") for i in range(21)])
    assert db.list_spaces(project) == []


def test_list_spaces_scoped_to_project_newest_first(db, project):
    first = db.create_space(project, "a")
    second = db.create_space(project, "b")
    other = db.create_space(f"{project}_other", "c")
    assert [s.id for s in db.list_spaces(project)] == [second.id, first.id]
    assert [s.id for s in db.list_spaces(project, [first.id])] == [first.id]
    with pytest.raises(SpaceNotFoundError):
        db.list_spaces(project, [first.id, other.id])
    with pytest.raises(SpaceNotFoundError):
        db.list_spaces(project, ["space_missing"])
    assert db.list_spaces(project, []) == []


def test_assert_spaces_checks_ownership_and_domains(db, project):
    a = db.create_space(project, "a", domains=[Domain(domain="开发"), Domain(domain="运维")])
    b = db.create_space(project, "b", domains=[Domain(domain="开发")])
    assert [s.id for s in db.assert_spaces(project, [b.id, a.id, b.id])] == [b.id, a.id]
    assert len(db.assert_spaces(project, [a.id, b.id], ["开发"])) == 2
    with pytest.raises(DomainNotFoundError):
        db.assert_spaces(project, [a.id, b.id], ["运维"])  # b lacks it
    with pytest.raises(SpaceNotFoundError):
        db.assert_spaces(f"{project}_other", [a.id])
    assert db.assert_spaces(project, []) == []


def test_update_space_keeps_omitted_fields(db, project):
    space = db.create_space(project, "旧名", instructions="指令")
    renamed = db.update_space(space.id, space_name="新名")
    assert (renamed.space_name, renamed.instructions) == ("新名", "指令")
    assert renamed.update_time > space.update_time and renamed.create_time == space.create_time
    assert db.update_space(space.id, instructions="新指令").space_name == "新名"
    assert db.update_space(space.id, instructions="").instructions is None
    assert db.list_spaces(project, [space.id])[0].space_name == "新名"
    with pytest.raises(SpaceNotFoundError):
        db.update_space("space_missing", space_name="x")


def test_delete_space_is_idempotent_and_removes_config(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain="开发")])
    add_topic(db, space.id, "开发")
    db.delete_space(space.id)
    db.delete_space(space.id)
    assert db.list_spaces(project) == []
    assert db.list_domains(space.id) == []


# ---------- domains ----------
def test_create_domains_keeps_existing_values(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain="开发", description="原说明")])
    result = db.create_domains(
        space.id, [Domain(domain="运维", description="新"), Domain(domain="开发", description="改")]
    )
    assert [(d.domain, d.description) for d in result] == [("运维", "新")]
    assert {d.domain: d.description for d in db.list_domains(space.id)} == {
        "开发": "原说明",
        "运维": "新",
    }
    with pytest.raises(SpaceNotFoundError):
        db.create_domains("space_missing", [Domain(domain="x")])


def test_create_domains_enforces_limit_for_whole_batch(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain=f"d{i}") for i in range(19)])
    with pytest.raises(DomainLimitExceededError):
        db.create_domains(space.id, [Domain(domain="x"), Domain(domain="y")])
    assert len(db.list_domains(space.id)) == 19
    db.create_domains(space.id, [Domain(domain="x"), Domain(domain="d0")])  # only one is new
    assert len(db.list_domains(space.id)) == 20


def test_update_domains_renames_and_keeps_id(db, project):
    space = db.create_space(
        project, "s", domains=[Domain(domain="开发", description="说明"), Domain(domain="运维")]
    )
    before = {d.domain: d.id for d in db.list_domains(space.id)}
    result = db.update_domains(
        space.id,
        [
            DomainUpdate(domain="开发", new_domain="工程"),
            DomainUpdate(domain="运维", description="值班"),
        ],
    )
    assert [(d.domain, d.description) for d in result] == [("工程", "说明"), ("运维", "值班")]
    assert result[0].id == before["开发"]
    assert sorted(names(db.list_domains(space.id))) == ["工程", "运维"]
    cleared = db.update_domains(space.id, [DomainUpdate(domain="工程", description="")])
    assert cleared[0].description == ""


def test_update_domains_rejects_whole_batch_on_error(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain="开发"), Domain(domain="运维")])
    with pytest.raises(DomainAlreadyExistsError):
        db.update_domains(
            space.id,
            [
                DomainUpdate(domain="开发", description="已改"),
                DomainUpdate(domain="运维", new_domain="开发"),
            ],
        )
    with pytest.raises(DomainNotFoundError):
        db.update_domains(
            space.id,
            [DomainUpdate(domain="开发", new_domain="工程"), DomainUpdate(domain="不存在")],
        )
    assert {d.domain: d.description for d in db.list_domains(space.id)} == {"开发": "", "运维": ""}


def test_same_domain_name_allowed_across_spaces(db, project):
    a = db.create_space(project, "a", domains=[Domain(domain="开发")])
    b = db.create_space(project, "b", domains=[Domain(domain="开发")])
    db.update_domains(a.id, [DomainUpdate(domain="开发", new_domain="工程")])
    assert names(db.list_domains(b.id)) == ["开发"]


def test_delete_domains_ignores_missing(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain="开发"), Domain(domain="运维")])
    deleted = db.delete_domains(space.id, ["运维", "不存在"])
    assert names(deleted) == ["运维"]
    assert names(db.list_domains(space.id)) == ["开发"]


def test_delete_domains_rejects_whole_batch_when_in_use(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain="开发"), Domain(domain="运维")])
    add_topic(db, space.id, "开发")
    with pytest.raises(DomainInUseError):
        db.delete_domains(space.id, ["运维", "开发"])
    assert sorted(names(db.list_domains(space.id))) == ["开发", "运维"]
    assert names(db.delete_domains(space.id, ["运维"])) == ["运维"]


def test_create_domains_dedupes_within_batch_and_lists_earliest_first(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain="z")])
    result = db.create_domains(
        space.id, [Domain(domain="b"), Domain(domain="a"), Domain(domain="b", description="重复")]
    )
    assert sorted((d.domain, d.description) for d in result) == [("a", ""), ("b", "")]
    listed = names(db.list_domains(space.id))
    assert listed[0] == "z" and sorted(listed[1:]) == ["a", "b"]


def test_update_space_requires_a_field(db, project):
    space = db.create_space(project, "s")
    with pytest.raises(ValueError):
        db.update_space(space.id)


def test_update_domains_rename_to_same_name_and_chain(db, project):
    space = db.create_space(project, "s", domains=[Domain(domain="a"), Domain(domain="b")])
    assert names(db.update_domains(space.id, [DomainUpdate(domain="a", new_domain="a")])) == ["a"]
    # sequential semantics: free "a" first, then reuse the name
    db.update_domains(
        space.id,
        [DomainUpdate(domain="a", new_domain="c"), DomainUpdate(domain="b", new_domain="a")],
    )
    assert sorted(names(db.list_domains(space.id))) == ["a", "c"]


def test_domain_methods_on_missing_space(db):
    with pytest.raises(DomainNotFoundError):
        db.update_domains("missing", [DomainUpdate(domain="a", description="x")])
    assert db.delete_domains("missing", ["a"]) == []
    assert db.list_domains("missing") == []


def test_full_space_and_domain_flow(db, project):
    """create/space -> list -> update -> domains CRUD -> topic blocks delete -> delete/space."""
    space = db.create_space(project, "Memmy 开发", domains=[Domain(domain="代码开发")])
    assert [s.id for s in db.list_spaces(project)] == [space.id]

    # get/space and add/message validation both go through assert_spaces
    (got,) = db.assert_spaces(project, [space.id], ["代码开发"])
    assert got.space_name == "Memmy 开发"

    updated = db.update_space(space.id, instructions="只记录工程决策")
    assert updated.instructions == "只记录工程决策"

    added = db.create_domains(space.id, [Domain(domain="运维", description="部署")])
    assert names(added) == ["运维"]
    db.update_domains(space.id, [DomainUpdate(domain="代码开发", new_domain="工程开发")])
    assert sorted(names(db.list_domains(space.id))) == ["工程开发", "运维"]
    with pytest.raises(DomainNotFoundError):
        db.assert_spaces(project, [space.id], ["代码开发"])  # old name is gone

    add_topic(db, space.id, "工程开发")
    with pytest.raises(DomainInUseError):
        db.delete_domains(space.id, ["工程开发", "运维"])
    assert names(db.delete_domains(space.id, ["运维"])) == ["运维"]

    db.delete_space(space.id)
    assert db.list_spaces(project) == []
    with pytest.raises(SpaceNotFoundError):
        db.assert_spaces(project, [space.id])
