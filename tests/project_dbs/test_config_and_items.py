from datetime import datetime, timezone

import pytest

from pydantic import ValidationError

from memos.configs.project_db import PostgresProjectDBConfig, ProjectDBConfigFactory
from memos.project_dbs.base import BaseProjectDB
from memos.project_dbs.item import Decision, HistoryItem, Topic, TopicChange, TopicFilter


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


def test_build_project_db_config_disabled_without_host(monkeypatch):
    from memos.api.handlers.config_builders import build_project_db_config

    monkeypatch.delenv("PROJECT_DB_HOST", raising=False)
    assert build_project_db_config() is None


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


def test_topic_change_parses_entry_union():
    change = TopicChange.model_validate(
        {
            "op": "create",
            "domain": "开发",
            "upsert_entries": [
                {"entry_type": "timeline", "content": "完成评审", "time": NOW, "user_ids": []},
                {"entry_type": "experience", "content": "先压测", "time": NOW, "user_ids": []},
            ],
        }
    )
    assert [e.entry_type for e in change.upsert_entries] == ["timeline", "experience"]


def test_topic_filter_nests():
    f = TopicFilter(op="or", children=[TopicFilter(user_ids=["a"]), TopicFilter(agent_ids=["x"])])
    assert len(f.children) == 2


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
        TopicChange.model_validate(
            {
                "op": "create",
                "domain": "开发",
                "upsert_entries": [{"content": "x", "time": NOW, "user_ids": []}],
            }
        )
