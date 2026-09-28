
from pydantic import BaseModel

from memos.mem_scheduler.general_modules.misc import EnvConfigMixin


class SampleConfig(EnvConfigMixin, BaseModel):
    host: str = "localhost"
    port: int | None = None
    debug: bool = False


def test_from_env_missing_optional_field_uses_default(monkeypatch):
    # a field whose default is None and whose env var is absent used to hit
    # a bare `raise ValueError()` with no message
    monkeypatch.delenv("MEMSCHEDULER_SAMPLE_PORT", raising=False)
    monkeypatch.delenv("MEMSCHEDULER_SAMPLE_HOST", raising=False)
    monkeypatch.delenv("MEMSCHEDULER_SAMPLE_DEBUG", raising=False)

    cfg = SampleConfig.from_env()

    assert cfg.host == "localhost"
    assert cfg.port is None
    assert cfg.debug is False


def test_from_env_parses_optional_and_bool_fields(monkeypatch):
    # Optional[int] used to keep the raw string because only exact `int`
    # annotations were parsed
    monkeypatch.setenv("MEMSCHEDULER_SAMPLE_PORT", "5672")
    monkeypatch.setenv("MEMSCHEDULER_SAMPLE_DEBUG", "true")

    cfg = SampleConfig.from_env()

    assert cfg.port == 5672
    assert isinstance(cfg.port, int)
    assert cfg.debug is True


def test_from_env_still_requires_required_fields(monkeypatch):
    from pydantic import Field

    class RequiredConfig(EnvConfigMixin, BaseModel):
        api_key: str = Field()

    monkeypatch.delenv("MEMSCHEDULER_REQUIRED_API_KEY", raising=False)
    try:
        RequiredConfig.from_env()
    except ValueError as e:
        assert "MEMSCHEDULER_REQUIRED_API_KEY" in str(e)
    else:
        raise AssertionError("expected ValueError for missing required env var")
