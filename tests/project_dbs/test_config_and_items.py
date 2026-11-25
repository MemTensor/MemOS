from datetime import datetime, timezone

import pytest

from pydantic import ValidationError

from memos.configs.project_db import PostgresProjectDBConfig, ProjectDBConfigFactory
from memos.project_dbs.base import BaseProjectDB
from memos.project_dbs.item import (
    ConflictCard,
    Decision,
    DecisionCard,
    DecisionExtra,
    EntrySource,
    EntryStatus,
    Experience,
    ExperienceCard,
    ExperienceExtra,
    JsonPart,
    Source,
    Space,
    Topic,
    TopicChangeSet,
    TopicCreate,
    TopicFilter,
    TopicUpdate,
)


NOW = datetime(2026, 11, 19, 10, 0, tzinfo=timezone.utc)
CARD = {"task_intent": "压测", "problem": "慢", "principle": "先压测"}


def test_config_factory_builds_postgres_config():
    factory = ProjectDBConfigFactory.model_validate(
        {
            "backend": "postgres",
            "config": {"host": "h", "user": "u", "password": "p", "db_name": "d"},
        }
    )
    assert isinstance(factory.config, PostgresProjectDBConfig)
    assert factory.config.port == 5432


def test_config_factory_rejects_unknown_backend():
    with pytest.raises(ValidationError):
        ProjectDBConfigFactory.model_validate({"backend": "mysql", "config": {}})


def test_build_project_db_config_requires_host(monkeypatch):
    from memos.api.handlers.config_builders import build_project_db_config

    monkeypatch.setenv("PROJECT_DB_BACKEND", "postgres")
    monkeypatch.delenv("PROJECT_DB_HOST", raising=False)
    with pytest.raises(ValueError, match="PROJECT_DB_HOST is required"):
        build_project_db_config()


def test_decision_defaults_and_embedding_excluded():
    d = Decision(content="采用方案B", chat_time=NOW, user_ids=["user_a"], embedding=[0.1, 0.2])
    dumped = d.model_dump()
    assert dumped["entry_type"] == "decision" and dumped["status"] == EntryStatus.ACTIVE == 0
    assert dumped["history"] == [] and dumped["conflicts"] == []
    assert dumped["extra"] == {"sources": [], "user_labels": {}}
    assert "embedding" not in dumped
    card = DecisionCard(content="A", chat_time=NOW, user_ids=[], embedding=[0.1])
    assert "embedding" not in card.model_dump()


def test_topic_assembles_entries():
    topic = Topic(
        id="topic_1",
        space_id="space_1",
        domain="开发",
        topic_name="存储选型",
        topic_summary="s",
        topic_description="d",
        decisions=[
            Decision(
                id="decision_1",
                content="采用方案B",
                chat_time=NOW,
                user_ids=["user_b"],
                history=[DecisionCard(content="采用方案A", chat_time=NOW, user_ids=["user_a"])],
            )
        ],
        create_time=NOW,
        update_time=NOW,
    )
    assert topic.decisions[0].history[0].content == "采用方案A"


def test_change_set_parses_creates_updates_and_entry_union():
    change_set = TopicChangeSet.model_validate(
        {
            "space_id": "s",
            "accept_time": NOW,
            "creates": [
                {
                    "domain": "开发",
                    "topic_name": "n",
                    "topic_summary": "s",
                    "topic_description": "d",
                    "create_time": NOW,
                    "update_time": NOW,
                    "entries": [
                        {
                            "entry_type": "timeline",
                            "content": "完成评审",
                            "chat_time": NOW,
                            "user_ids": [],
                        },
                        {
                            "entry_type": "experience",
                            "content": "先压测",
                            "chat_time": NOW,
                            "user_ids": [],
                            "extra": {"card": CARD},
                        },
                    ],
                }
            ],
            "updates": [{"topic_id": "t", "expected_version": 2, "topic_summary": "新摘要"}],
        }
    )
    assert [e.entry_type for e in change_set.creates[0].entries] == ["timeline", "experience"]
    update = change_set.updates[0]
    assert (update.domain, update.topic_description, update.upsert_entries) == (None, None, [])


def test_topic_filter_groups():
    f = TopicFilter.model_validate({"create_time": {"gte": NOW}, "update_time": {"lt": NOW}})
    assert f.create_time.gte == NOW and f.update_time.lt == NOW
    assert TopicFilter().create_time is None


def test_base_is_abstract():
    with pytest.raises(TypeError):
        BaseProjectDB()


def test_build_project_db_config_from_env(monkeypatch):
    from memos.api.handlers.config_builders import build_project_db_config

    monkeypatch.setenv("PROJECT_DB_HOST", "pg")
    monkeypatch.setenv("PROJECT_DB_PORT", "5433")
    monkeypatch.setenv("EMBEDDING_DIMENSION", "768")
    config = build_project_db_config().config
    assert (config.host, config.port, config.embedding_dimension) == ("pg", 5433, 768)


def test_config_rejects_minconn_above_maxconn():
    with pytest.raises(ValidationError):
        PostgresProjectDBConfig(host="h", user="u", password="p", db_name="d", minconn=5, maxconn=2)


def test_entry_without_type_is_rejected():
    with pytest.raises(ValidationError):
        TopicUpdate.model_validate(
            {
                "topic_id": "t",
                "expected_version": 1,
                "upsert_entries": [{"content": "x", "chat_time": NOW, "user_ids": []}],
            }
        )


def test_topic_filter_rejects_unknown_keys():
    with pytest.raises(ValidationError):
        TopicFilter.model_validate({"user_ids": ["a"]})
    with pytest.raises(ValidationError):
        TopicFilter.model_validate({"update_time": {"after": NOW}})


@pytest.mark.parametrize("parser", ["zhparser", "simple"])
def test_rendered_ddl_keeps_text_search_config_executable(parser):
    from memos.project_dbs.postgres import PostgresProjectDB

    store = PostgresProjectDB.__new__(PostgresProjectDB)  # render only, no connection
    store.config = PostgresProjectDBConfig(
        host="h", user="u", password="p", db_name="d", text_search_parser=parser
    )
    ddl = store._render_ddl()
    assert "{" + "text_search_config}" not in ddl and "{" + "embedding_dimension}" not in ddl
    lines = [line for line in ddl.splitlines() if "TEXT SEARCH CONFIGURATION" in line]
    assert lines and not any(line.lstrip().startswith("--") for line in lines)
    assert ddl.index("CREATE SCHEMA") < ddl.index("TEXT SEARCH CONFIGURATION")
    assert ("PARSER = zhparser" in ddl) == (parser == "zhparser")


def test_build_project_db_config_normalizes_parser(monkeypatch):
    from memos.api.handlers.config_builders import build_project_db_config

    monkeypatch.setenv("PROJECT_DB_HOST", "pg")
    monkeypatch.setenv("PROJECT_DB_TEXT_SEARCH_PARSER", " Simple ")
    assert build_project_db_config().config.text_search_parser == "simple"
    monkeypatch.setenv("PROJECT_DB_TEXT_SEARCH_PARSER", "")
    assert build_project_db_config().config.text_search_parser == "zhparser"


def test_json_parts_keep_unknown_keys_and_strict_models_reject_them():
    extra = DecisionExtra.model_validate({"sources": [{"quote": "q", "pos": 3}], "x": 1})
    assert extra.model_dump()["x"] == 1 and extra.sources[0].model_dump()["pos"] == 3
    assert JsonPart.model_validate({"a": [1]}).model_dump() == {"a": [1]}
    with pytest.raises(ValidationError):
        TopicUpdate.model_validate({"topic_id": "t", "expected_version": 1, "typo": 1})
    with pytest.raises(ValidationError):
        TopicChangeSet.model_validate({"space_id": "s", "accepted_at": NOW})  # old name


def test_topic_create_requires_chat_times():
    with pytest.raises(ValidationError):
        TopicCreate(domain="d", topic_name="n", topic_summary="s", topic_description="d")


def test_experience_requires_a_card_and_bounds_confidence():
    with pytest.raises(ValidationError):
        Experience(content="x", chat_time=NOW, user_ids=[])
    exp = Experience(content="x", chat_time=NOW, user_ids=[], extra={"card": CARD})
    assert (exp.extra.exp_status, exp.extra.confidence) == ("candidate", 0.5)
    assert isinstance(exp.extra.card, ExperienceCard)
    for bad in (0.05, 0.99):
        with pytest.raises(ValidationError):
            ExperienceExtra(card=CARD, confidence=bad)
    with pytest.raises(ValidationError):
        ExperienceExtra(card=CARD, exp_status="retired")


def test_source_and_space_shapes():
    assert Source().model_dump() == {"conversation_id": None, "user_id": [], "agent_id": None}
    with pytest.raises(ValidationError):
        Source(user_id="u1")
    space = Space(id="s", project_id="p", space_name="n", create_time=NOW, update_time=NOW)
    assert space.clear_time is None


def test_conflict_card_carries_id_and_source():
    card = ConflictCard(
        id="c1", content="C", chat_time=NOW, user_ids=["b"], source=EntrySource(message_id="m")
    )
    assert card.model_dump()["source"]["message_id"] == "m"
