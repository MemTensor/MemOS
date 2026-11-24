"""项目记忆用例的公共清理：删掉 Postgres 用例建的临时 schema。"""

import pytest

from tests.project_memory.helpers import drop_test_dbs


@pytest.fixture(autouse=True)
def _drop_postgres_schemas():
    yield
    drop_test_dbs()
