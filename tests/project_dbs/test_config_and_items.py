from datetime import datetime, timezone

import pytest

from pydantic import ValidationError

from memos.configs.project_db import PostgresProjectDBConfig, ProjectDBConfigFactory
from memos.project_dbs.base import BaseProjectDB
from memos.project_dbs.item import (
    Decision,
    HistoryItem,
    Topic,
    TopicChangeSet,
    TopicFilter,
    TopicUpdate,
)


NOW = datetime(2026, 11, 19, 10, 0, tzinfo=timezone.utc)


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
    d = Decision(content="采用方案B", time=NOW, user_ids=["user_a"], embedding=[0.1, 0.2])
    dumped = d.model_dump()
    assert dumped["entry_type"] == "decision"
    assert dumped["history"] == [] and dumped["conflicts"] == []
    assert "embedding" not in dumped


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
                time=NOW,
                user_ids=["user_b"],
                history=[HistoryItem(content="采用方案A", time=NOW, user_ids=["user_a"])],
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
            "accepted_at": NOW,
            "creates": [
                {
                    "domain": "开发",
                    "topic_name": "n",
                    "topic_summary": "s",
                    "topic_description": "d",
                    "entries": [
                        {
                            "entry_type": "timeline",
                            "content": "完成评审",
                            "time": NOW,
                            "user_ids": [],
                        },
                        {
                            "entry_type": "experience",
                            "content": "先压测",
                            "time": NOW,
                            "user_ids": [],
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
                "upsert_entries": [{"content": "x", "time": NOW, "user_ids": []}],
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
