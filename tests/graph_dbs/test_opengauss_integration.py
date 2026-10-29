"""Opt-in, real-driver AGE storage tests in a disposable database.

Set MEMOS_OPENGAUSS_TEST_CONFIG to an OpenGaussGraphDBConfig JSON object for a
test administrator. These tests create/drop only their own UUID database and
role; the application under test uses an ordinary role, without SYSADMIN.
"""

import json
import os
import secrets
import threading
import time
import uuid

from concurrent.futures import ThreadPoolExecutor

import pytest

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import GraphDBError
from memos.graph_dbs._opengauss_store import OpenGaussNodeStore


psycopg2 = pytest.importorskip("psycopg2")
sql = pytest.importorskip("psycopg2.sql")


pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


def _connect(config):
    return psycopg2.connect(
        host=config.host,
        port=config.port,
        dbname=config.db_name,
        user=config.user,
        password=config.password,
        connect_timeout=5,
        application_name="memos-opengauss-it-admin",
    )


def _query(admin, statement, params=()):
    with admin.cursor() as cursor:
        cursor.execute("SELECT 'null'::ag_catalog.agtype")
        cursor.execute("SET search_path = ag_catalog, public")
        cursor.execute(statement, params)
        return cursor.fetchall() if cursor.description else []


@pytest.fixture(scope="module")
def database():
    config = OpenGaussGraphDBConfig.model_validate_json(os.environ["MEMOS_OPENGAUSS_TEST_CONFIG"])
    manager = _connect(config)
    manager.autocommit = True
    suffix = uuid.uuid4().hex[:12]
    name, role = "memos_it_" + suffix, "memos_it_app_" + suffix
    password = "It_A7_" + secrets.token_hex(8)
    created_database = created_role = False
    admin = None
    try:
        with manager.cursor() as cursor:
            cursor.execute(
                sql.SQL("CREATE USER {} PASSWORD %s").format(sql.Identifier(role)), (password,)
            )
            created_role = True
            cursor.execute(
                sql.SQL("CREATE DATABASE {} DBCOMPATIBILITY 'PG'").format(sql.Identifier(name))
            )
            created_database = True
        target = config.model_copy(update={"db_name": name})
        admin = _connect(target)
        admin.autocommit = True
        with admin.cursor() as cursor:
            cursor.execute("CREATE EXTENSION age")
            cursor.execute(
                sql.SQL("GRANT CREATE ON DATABASE {} TO {}").format(
                    sql.Identifier(name), sql.Identifier(role)
                )
            )
            cursor.execute(
                sql.SQL("GRANT USAGE ON SCHEMA ag_catalog TO {}").format(sql.Identifier(role))
            )
            cursor.execute(
                sql.SQL("GRANT SELECT ON ag_catalog.ag_graph,ag_catalog.ag_label TO {}").format(
                    sql.Identifier(role)
                )
            )
        application = target.model_copy(
            update={
                "user": role,
                "password": password,
                "user_name": "A",
                "embedding_dimension": 3,
                "minconn": 1,
                "maxconn": 2,
            }
        )
        yield admin, application
    finally:
        if admin is not None:
            admin.close()
        with manager.cursor() as cursor:
            if created_database:
                cursor.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))
            if created_role:
                cursor.execute(sql.SQL("DROP USER {}").format(sql.Identifier(role)))
        manager.close()


@pytest.fixture
def stores(database):
    admin, config = database
    opened = []
    if _query(admin, "SELECT 1 FROM ag_catalog.ag_graph WHERE name='memos_graph'"):
        _query(admin, "SELECT ag_catalog.drop_graph('memos_graph',true)")

    def make(**overrides):
        store = OpenGaussNodeStore(config.model_copy(update=overrides))
        opened.append(store)
        return store

    yield make
    for store in opened:
        store.close()
    # Client close sends Terminate without waiting for backend termination.
    # Verify server cleanup within a fixed deadline; a persistent leak fails.
    deadline = time.monotonic() + 5
    while True:
        remaining = _query(
            admin,
            "SELECT count(*) FROM pg_stat_activity WHERE datname=%s AND application_name='memos-opengauss'",
            (config.db_name,),
        )
        if remaining == [(0,)] or time.monotonic() >= deadline:
            break
        time.sleep(0.01)
    assert remaining == [(0,)]


def test_registered_age_label_and_ordinary_application_role(stores, database):
    db = stores()
    admin, config = database
    assert _query(
        admin, "SELECT rolsystemadmin FROM pg_roles WHERE rolname=%s", (config.user,)
    ) == [(False,)]
    assert _query(
        admin,
        "SELECT l.kind FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.oid=l.graph WHERE g.name='memos_graph' AND l.name='Memory'",
    ) == [("v",)]
    db.add_node(
        "one",
        "中文 emoji 🚀 ' ; DROP TABLE Memory; --\n",
        {"embedding": [1, 0, 0], "info": {"nested": [True, None, 3]}},
    )
    row = db.get_node("one", include_embedding=True)
    assert row == {
        "id": "one",
        "memory": "中文 emoji 🚀 ' ; DROP TABLE Memory; --\n",
        "metadata": {"embedding": [1, 0, 0], "info": {"nested": [True, None, 3]}},
    }


@pytest.mark.parametrize(
    "value", [None, [], {}, "raw or malformed JSON {", [{"type": "chat", "content": "fixture"}]]
)
def test_structured_and_serialized_metadata_round_trip(stores, value):
    db = stores()
    metadata = {
        "sources": value,
        "usage": value,
        "info": value,
        "created_at": "2026-01-01T00:00:00Z",
    }
    db.add_node("one", "", metadata)
    assert db.get_node("one") == {"id": "one", "memory": "", "metadata": metadata}
    assert db.get_node("one", include_embedding=True)["metadata"]["embedding"] is None


def test_scopes_batch_order_last_upsert_and_missing_records(stores):
    db = stores()
    db.add_nodes_batch(
        [
            {"id": "same", "memory": "before"},
            {"id": "two", "memory": "second"},
            {"id": "same", "memory": "last", "metadata": {"status": "archived"}},
        ]
    )
    db.add_node("same", "scope B", {}, user_name="B")
    assert db.get_nodes(["two", "absent", "same", "two"]) == [
        {"id": "two", "memory": "second", "metadata": {}},
        {"id": "same", "memory": "last", "metadata": {"status": "archived"}},
    ]
    assert db.get_node("same", user_name="B")["memory"] == "scope B"
    assert db.get_node("absent") is None
    db.update_node("absent", {"memory": "no insert"})
    assert db.get_node("absent") is None
    with pytest.raises(ValueError):
        db.update_node("same", {"user_name": "B"})
    assert db.get_node("same", user_name="B")["memory"] == "scope B"


def test_upsert_and_update_preserve_graphid_edges_and_projection(stores, database):
    db = stores()
    admin, _ = database
    db.add_nodes_batch(
        [
            {
                "id": "one",
                "memory": "before",
                "metadata": {"embedding": [1, 0, 0], "tags": ["old"]},
            },
            {"id": "two", "memory": "target"},
        ]
    )
    graphid = _query(
        admin,
        'SELECT id::text FROM memos_graph."Memory" WHERE scope=%s AND business_id=%s',
        ("A", "one"),
    )[0][0]
    _query(
        admin,
        "SELECT * FROM ag_catalog.cypher('memos_graph',$$MATCH (a:Memory {id:'one',user_name:'A'}),(b:Memory {id:'two',user_name:'A'}) CREATE (a)-[:RELATE_TO]->(b) RETURN id(a)$$) AS (id agtype)",
    )
    db.add_node("one", "replacement", {"embedding": [0, 1, 0], "tags": ["retained"]})
    db.update_node("one", {"info": {"updated": True}, "memory": "updated"})
    assert db.get_node("one", include_embedding=True) == {
        "id": "one",
        "memory": "updated",
        "metadata": {"embedding": [0, 1, 0], "tags": ["retained"], "info": {"updated": True}},
    }
    rows = _query(
        admin,
        "SELECT * FROM ag_catalog.cypher('memos_graph',$$MATCH (a:Memory)-[r:RELATE_TO]->(b:Memory) RETURN id(a),a.memory,b.id$$) AS (id agtype,memory agtype,target agtype)",
    )
    assert len(rows) == 1
    assert [json.loads(value) for value in rows[0]] == [int(graphid), "updated", "two"]
    db.update_node("one", {"embedding": []})
    assert db.get_node("one", include_embedding=True)["metadata"]["embedding"] is None
    assert _query(
        admin,
        'SELECT id::text,embedding::text FROM memos_graph."Memory" WHERE business_id=%s',
        ("one",),
    ) == [(graphid, None)]


@pytest.mark.parametrize("position", [0, 1, 2])
def test_execution_failure_rolls_back_entire_batch(stores, database, position):
    db = stores()
    admin, _ = database
    db.add_node("keep", "existing", {})
    _query(
        admin,
        "CREATE OR REPLACE FUNCTION public.memos_it_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.business_id='bad' THEN RAISE EXCEPTION 'synthetic rejected row'; END IF; RETURN NEW; END $$",
    )
    _query(
        admin,
        'CREATE TRIGGER memos_it_reject BEFORE INSERT ON memos_graph."Memory" FOR EACH ROW EXECUTE PROCEDURE public.memos_it_reject()',
    )
    nodes = [{"id": str(i), "memory": "temporary"} for i in range(3)]
    nodes[position]["id"] = "bad"
    with pytest.raises(GraphDBError) as error:
        db.add_nodes_batch(nodes)
    assert error.value.__cause__.pgcode == "P0001"
    assert _query(admin, 'SELECT scope,business_id,memory FROM memos_graph."Memory"') == [
        ("A", "keep", "existing")
    ]
    assert db.get_node("keep")["memory"] == "existing"


def test_other_unique_constraints_cannot_upsert_another_scope(stores, database):
    db = stores()
    admin, _ = database
    db.add_node("foreign", "same text", {}, user_name="B")
    _query(admin, 'CREATE UNIQUE INDEX memos_it_text_unique ON memos_graph."Memory" (memory)')
    with pytest.raises(GraphDBError) as error:
        db.add_node("new", "same text", {}, user_name="A")
    assert error.value.__cause__.pgcode == "23505"
    assert db.get_node("new") is None
    assert db.get_node("foreign", user_name="B") == {
        "id": "foreign",
        "memory": "same text",
        "metadata": {},
    }


def test_reinitialization_and_concurrent_initialization_preserve_data(stores, database):
    barrier = threading.Barrier(2, timeout=10)

    def initialize():
        barrier.wait()
        return stores()

    with ThreadPoolExecutor(2) as executor:
        one, two = [
            future.result(timeout=20)
            for future in [executor.submit(initialize), executor.submit(initialize)]
        ]
    one.add_node("persisted", "existing", {})
    one.close()
    three = stores()
    assert (
        two.get_node("persisted")
        == three.get_node("persisted")
        == {"id": "persisted", "memory": "existing", "metadata": {}}
    )


def test_concurrent_upserts_are_unique_and_complete(stores, database):
    db = stores()
    admin, _ = database
    barrier = threading.Barrier(2, timeout=10)

    def write(writer):
        barrier.wait()
        db.add_node("one", writer, {"info": {"writer": writer}})

    with ThreadPoolExecutor(2) as executor:
        futures = [executor.submit(write, writer) for writer in ["first", "second"]]
        for future in futures:
            future.result(timeout=15)
    assert _query(admin, 'SELECT count(*) FROM memos_graph."Memory"') == [(1,)]
    node = db.get_node("one")
    assert node in [
        {"id": "one", "memory": writer, "metadata": {"info": {"writer": writer}}}
        for writer in ["first", "second"]
    ]


def test_partial_update_reads_after_row_lock_without_losing_fields(stores):
    db = stores()
    db.add_node("one", "before", {})
    barrier = threading.Barrier(2, timeout=10)

    def update():
        barrier.wait()
        db.update_node("one", {"tags": ["second"]})

    with ThreadPoolExecutor(1) as executor:
        with db._pool.transaction() as connection, connection.cursor() as cursor:
            cursor.execute(
                'UPDATE memos_graph."Memory" SET properties=%s::agtype WHERE scope=%s AND business_id=%s',
                (
                    json.dumps(
                        {"id": "one", "memory": "before", "user_name": "A", "info": {"first": 1}}
                    ),
                    "A",
                    "one",
                ),
            )
            future = executor.submit(update)
            barrier.wait()
        future.result(timeout=15)
    assert db.get_node("one") == {
        "id": "one",
        "memory": "before",
        "metadata": {"info": {"first": 1}, "tags": ["second"]},
    }


def test_failed_transactions_dirty_sessions_and_replacement_connections(stores):
    db = stores(maxconn=1)
    db.add_node("one", "keep", {})
    with (
        pytest.raises(GraphDBError) as error,
        db._pool.transaction() as connection,
        connection.cursor() as cursor,
    ):
        cursor.execute("SELECT 1/0")
    assert error.value.__cause__.pgcode == "22012"
    with db._pool.transaction() as connection, connection.cursor() as cursor:
        cursor.execute("SET search_path = pg_catalog")
    with db._pool.transaction() as connection, connection.cursor() as cursor:
        cursor.execute("SHOW search_path")
        assert cursor.fetchone()[0] == "ag_catalog, public"
        cursor.execute(
            "SELECT * FROM ag_catalog.cypher('memos_graph',$$MATCH (n:Memory) RETURN n.id$$) AS (id agtype)"
        )
        assert json.loads(cursor.fetchone()[0]) == "one"
    connection.set_session(isolation_level="SERIALIZABLE", readonly=True, autocommit=True)
    with db._pool.transaction() as connection, connection.cursor() as cursor:
        assert connection.autocommit is False
        cursor.execute("SHOW transaction_isolation")
        assert cursor.fetchone()[0] == "read committed"
        cursor.execute("SHOW transaction_read_only")
        assert cursor.fetchone()[0] == "off"
    connection.close()
    with pytest.raises(GraphDBError, match="closed connection"):
        db.get_node("one")
    assert db.get_node("one")["memory"] == "keep"


def test_bounded_wait_recovery_close_and_post_close_empty_calls(stores):
    db = stores(maxconn=1, connection_wait_timeout=1)
    with db._pool.transaction(), pytest.raises(GraphDBError, match="wait timed out"):
        db.get_node("missing")
    assert db.get_node("missing") is None
    db.close()
    db.close()
    for action in [
        lambda: db.add_nodes_batch([]),
        lambda: db.get_nodes([]),
        lambda: db.update_node("one", {}),
    ]:
        with pytest.raises(GraphDBError, match="closed"):
            action()


def test_incompatible_dimensions_do_not_change_existing_data(stores):
    db = stores()
    db.add_node("one", "keep", {"embedding": [1, 0, 0]})
    with pytest.raises(GraphDBError, match="incompatible"):
        stores(embedding_dimension=4)
    assert db.get_node("one", include_embedding=True)["metadata"]["embedding"] == [1, 0, 0]


def test_wrong_credentials_fail_without_password_in_public_error(stores):
    with pytest.raises(GraphDBError) as error:
        stores(password="Synthetic_Wrong_Password_A7")
    assert isinstance(error.value.__cause__, psycopg2.OperationalError)
    assert "Invalid username/password,login denied" in str(error.value.__cause__)
    assert "Synthetic_Wrong_Password_A7" not in str(error.value)


def test_unregistered_schema_is_not_adopted_or_destroyed(stores, database):
    admin, _ = database
    _query(admin, "CREATE SCHEMA memos_graph")
    with pytest.raises(GraphDBError):
        stores()
    assert _query(admin, "SELECT 1 FROM pg_namespace WHERE nspname='memos_graph'") == [(1,)]
    _query(admin, "DROP SCHEMA memos_graph")


def test_incomplete_registered_label_is_rejected_with_data_preserved(stores, database):
    admin, config = database
    _query(admin, "SELECT ag_catalog.create_graph('memos_graph')")
    _query(
        admin,
        "SELECT * FROM ag_catalog.cypher('memos_graph',$$CREATE (n:Memory {id:'legacy'}) RETURN n.id$$) AS (id agtype)",
    )
    _query(
        admin,
        sql.SQL("GRANT USAGE ON SCHEMA memos_graph TO {}").format(sql.Identifier(config.user)),
    )
    with pytest.raises(GraphDBError, match="incompatible"):
        stores()
    assert _query(admin, 'SELECT count(*) FROM memos_graph."Memory"') == [(1,)]


def test_missing_extension_fails_and_closes_its_connections(stores, database):
    admin, _ = database
    name = "memos_it_no_age_" + uuid.uuid4().hex[:12]
    _query(admin, sql.SQL("CREATE DATABASE {} DBCOMPATIBILITY 'PG'").format(sql.Identifier(name)))
    try:
        with pytest.raises(GraphDBError) as error:
            stores(db_name=name)
        # This openGauss build reports 3F001 for an absent ag_catalog schema.
        assert error.value.__cause__.pgcode == "3F001"
        assert _query(admin, "SELECT count(*) FROM pg_stat_activity WHERE datname=%s", (name,)) == [
            (0,)
        ]
    finally:
        _query(admin, sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


def test_missing_create_privilege_fails_without_partial_graph(stores, database):
    admin, config = database
    _query(
        admin,
        sql.SQL("REVOKE CREATE ON DATABASE {} FROM {}").format(
            sql.Identifier(config.db_name), sql.Identifier(config.user)
        ),
    )
    try:
        with pytest.raises(GraphDBError) as error:
            stores()
        assert error.value.__cause__.pgcode == "42501"
        assert _query(
            admin, "SELECT count(*) FROM ag_catalog.ag_graph WHERE name='memos_graph'"
        ) == [(0,)]
    finally:
        _query(
            admin,
            sql.SQL("GRANT CREATE ON DATABASE {} TO {}").format(
                sql.Identifier(config.db_name), sql.Identifier(config.user)
            ),
        )


def test_missing_unique_constraint_is_not_silently_repaired(stores, database):
    db = stores()
    admin, _ = database
    db.add_node("one", "keep", {})
    name = _query(
        admin,
        "SELECT conname FROM pg_constraint WHERE conrelid=%s::regclass AND contype='u'",
        ('memos_graph."Memory"',),
    )[0][0]
    _query(
        admin,
        sql.SQL('ALTER TABLE memos_graph."Memory" DROP CONSTRAINT {}').format(sql.Identifier(name)),
    )
    with pytest.raises(GraphDBError, match="incompatible"):
        stores()
    assert db.get_node("one")["memory"] == "keep"


def test_registered_graph_without_memory_label_can_be_completed(stores, database):
    _, config = database
    connection = _connect(config)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 'null'::ag_catalog.agtype")
            cursor.execute("SET search_path = ag_catalog, public")
            cursor.execute("SELECT ag_catalog.create_graph('memos_graph')")
        connection.commit()
    finally:
        connection.close()
    db = stores()
    db.add_node("one", "completed", {})
    assert db.get_node("one")["memory"] == "completed"


def test_optional_physical_scope_stays_separate_from_explicit_scope(stores):
    db = stores(use_multi_db=True, user_name=None)
    db.add_node("same", "physical default", {})
    db.add_node("same", "logical B", {}, user_name="B")
    assert db.get_node("same")["memory"] == "physical default"
    assert db.get_node("same", user_name="B")["memory"] == "logical B"


@pytest.mark.parametrize("position", [0, 1, 2])
def test_preparation_failure_leaves_existing_data_untouched(stores, database, position):
    db = stores()
    admin, _ = database
    db.add_node("keep", "existing", {})
    nodes = [{"id": str(i), "memory": "temporary"} for i in range(3)]
    nodes[position]["metadata"] = {"embedding": [1, 0]}
    with pytest.raises(ValueError, match="embedding"):
        db.add_nodes_batch(nodes)
    assert _query(admin, 'SELECT scope,business_id,memory FROM memos_graph."Memory"') == [
        ("A", "keep", "existing")
    ]


def _relation_fixture(db):
    for scope in ("A", "B"):
        db.add_nodes_batch(
            [
                {"id": "one", "memory": "source", "metadata": {"embedding": [1, 0, 0]}},
                {"id": "two", "memory": "target"},
                {"id": "three", "memory": "unconnected"},
            ],
            user_name=scope,
        )
        db.add_edge("one", "two", "RELATE_TO", user_name=scope)
    db.add_edge("two", "one", "FOLLOWS")
    db.add_edge("one", "one", "SELF")
    db.add_edge("one", "two", "PARENT")


@pytest.mark.parametrize(
    "direction,expected",
    [
        (
            "OUTGOING",
            [
                {"from": "one", "to": "one", "type": "SELF"},
                {"from": "one", "to": "two", "type": "PARENT"},
                {"from": "one", "to": "two", "type": "RELATE_TO"},
            ],
        ),
        (
            "INCOMING",
            [
                {"from": "one", "to": "one", "type": "SELF"},
                {"from": "two", "to": "one", "type": "FOLLOWS"},
            ],
        ),
        (
            "ANY",
            [
                {"from": "one", "to": "one", "type": "SELF"},
                {"from": "one", "to": "two", "type": "PARENT"},
                {"from": "one", "to": "two", "type": "RELATE_TO"},
                {"from": "two", "to": "one", "type": "FOLLOWS"},
            ],
        ),
    ],
)
def test_age_edge_directions_return_true_endpoints(stores, direction, expected):
    db = stores()
    _relation_fixture(db)
    assert db.get_edges("one", direction=direction) == expected
    assert db.get_edges("one", user_name="B") == [{"from": "one", "to": "two", "type": "RELATE_TO"}]


def test_age_edge_existence_neighbors_and_exact_deletion(stores):
    db = stores()
    _relation_fixture(db)
    assert db.edge_exists("one", "two", "RELATE_TO")
    assert not db.edge_exists("one", "two", "RELATE_TO", "INCOMING")
    assert db.edge_exists("one", "two", "FOLLOWS", "INCOMING")
    assert db.edge_exists("one", "two", direction="ANY")
    assert db.edge_exists("one", "one", "SELF")
    assert db.get_neighbors("one", "ANY", "out") == ["one", "two"]
    assert db.get_neighbors("one", "FOLLOWS", "in") == ["two"]
    assert db.get_neighbors("one", "ANY", "both") == ["one", "two"]
    assert db.get_neighbors("three", "ANY") == []
    assert db.get_edges("absent") == []
    assert not db.edge_exists("one", "absent")
    db.delete_edge("one", "two", "RELATE_TO")
    db.delete_edge("one", "two", "RELATE_TO")
    assert db.get_edges("one") == [
        {"from": "one", "to": "one", "type": "SELF"},
        {"from": "one", "to": "two", "type": "PARENT"},
        {"from": "two", "to": "one", "type": "FOLLOWS"},
    ]
    assert db.edge_exists("one", "two", "RELATE_TO", user_name="B")
    assert db.get_edges("one", "NOT_CREATED") == []


@pytest.mark.parametrize(
    "source,target", [("absent", "two"), ("one", "absent"), ("absent", "absent")]
)
def test_age_missing_endpoints_never_create_nodes_or_edges(stores, source, target):
    db = stores()
    db.add_node("one", "source", {})
    db.add_node("two", "other scope", {}, user_name="B")
    db.add_edge(source, target, "RELATE_TO")
    db.delete_edge(source, target, "RELATE_TO")
    assert db.get_edges("one") == []
    assert db.get_node("absent") is None


def test_age_cross_scope_write_and_external_cross_scope_read_are_blocked(stores, database):
    db = stores()
    admin, _ = database
    db.add_node("one", "A source", {})
    db.add_node("two", "B target", {}, user_name="B")
    db.add_edge("one", "two", "RELATE_TO")
    assert _query(admin, "SELECT count(*) FROM memos_graph._ag_label_edge") == [(0,)]
    _query(
        admin,
        "SELECT * FROM ag_catalog.cypher('memos_graph',$$MATCH (a:Memory {id:'one',user_name:'A'}),(b:Memory {id:'two',user_name:'B'}) CREATE (a)-[:RELATE_TO]->(b)$$) AS (result agtype)",
    )
    assert db.get_edges("one") == []
    assert db.get_edges("two", user_name="B") == []
    assert not db.edge_exists("one", "two")


def test_age_duplicate_parallel_self_edges_and_concurrency(stores, database):
    db = stores()
    admin, _ = database
    db.add_nodes_batch([{"id": "one", "memory": "source"}, {"id": "two", "memory": "target"}])
    barrier = threading.Barrier(2)

    def write(_):
        barrier.wait(timeout=5)
        db.add_edge("one", "two", "RELATE_TO")

    with ThreadPoolExecutor(2) as executor:
        list(executor.map(write, range(2)))
    db.add_edge("one", "two", "RELATE_TO")
    db.add_edge("one", "two", "PARENT")
    db.add_edge("one", "one", "SELF")
    assert _query(admin, "SELECT count(*) FROM memos_graph._ag_label_edge") == [(3,)]
    assert db.get_edges("one") == [
        {"from": "one", "to": "one", "type": "SELF"},
        {"from": "one", "to": "two", "type": "PARENT"},
        {"from": "one", "to": "two", "type": "RELATE_TO"},
    ]


def test_age_hard_delete_detaches_all_edges_and_preserves_other_scope(stores, database):
    db = stores()
    admin, _ = database
    _relation_fixture(db)
    db.delete_node("one")
    db.delete_node("one")
    db.delete_node("absent")
    assert db.get_nodes(["one", "two", "three"]) == [
        {"id": "two", "memory": "target", "metadata": {}},
        {"id": "three", "memory": "unconnected", "metadata": {}},
    ]
    assert db.get_node("one", include_embedding=True, user_name="B") == {
        "id": "one",
        "memory": "source",
        "metadata": {"embedding": [1, 0, 0]},
    }
    assert db.get_edges("two") == []
    assert db.get_edges("one", user_name="B") == [{"from": "one", "to": "two", "type": "RELATE_TO"}]
    assert _query(admin, "SELECT count(*) FROM memos_graph._ag_label_edge") == [(1,)]
    assert _query(
        admin,
        'SELECT count(*) FROM ONLY memos_graph."Memory" WHERE scope=%s AND business_id=%s',
        ("A", "one"),
    ) == [(0,)]


@pytest.mark.parametrize("failure", ["trigger", "permission"])
def test_age_detach_failure_rolls_back_edges_node_and_retrieval_columns(stores, database, failure):
    db = stores()
    admin, config = database
    _relation_fixture(db)
    if failure == "trigger":
        _query(
            admin,
            "CREATE OR REPLACE FUNCTION public.memos_it_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rejected delete'; END $$",
        )
        _query(
            admin,
            'CREATE TRIGGER memos_it_reject_delete BEFORE DELETE ON memos_graph."Memory" FOR EACH ROW EXECUTE PROCEDURE public.memos_it_reject_delete()',
        )
    else:
        owner = _query(admin, "SELECT current_user")[0][0]
        _query(
            admin,
            sql.SQL('ALTER TABLE memos_graph."Memory" OWNER TO {}').format(sql.Identifier(owner)),
        )
        _query(
            admin,
            sql.SQL('GRANT SELECT, UPDATE ON memos_graph."Memory" TO {}').format(
                sql.Identifier(config.user)
            ),
        )
    with pytest.raises(GraphDBError) as error:
        db.delete_node("one")
    assert error.value.__cause__.pgcode == ("P0001" if failure == "trigger" else "42501")
    assert db.get_node("one", include_embedding=True) == {
        "id": "one",
        "memory": "source",
        "metadata": {"embedding": [1, 0, 0]},
    }
    assert db.get_edges("one") == [
        {"from": "one", "to": "one", "type": "SELF"},
        {"from": "one", "to": "two", "type": "PARENT"},
        {"from": "one", "to": "two", "type": "RELATE_TO"},
        {"from": "two", "to": "one", "type": "FOLLOWS"},
    ]
    assert db.edge_exists("one", "two", "RELATE_TO", user_name="B")
    with db._pool.transaction() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM pg_prepared_statements")
        assert cursor.fetchone() == (0,)
    if failure == "trigger":
        _query(admin, 'DROP TRIGGER memos_it_reject_delete ON memos_graph."Memory"')
    else:
        _query(
            admin,
            sql.SQL('ALTER TABLE memos_graph."Memory" OWNER TO {}').format(
                sql.Identifier(config.user)
            ),
        )
    db.delete_node("one")
    assert db.get_node("one") is None


@pytest.mark.parametrize("physical", [False, True])
def test_age_bound_special_ids_and_scopes_round_trip(stores, physical):
    scope = None if physical else "中文 $$ ' ; --"
    db = stores(use_multi_db=physical, user_name=scope)
    source, target = "a\" $$ ' \\ ; --", "中文\n$target"
    db.add_nodes_batch([{"id": source, "memory": "source"}, {"id": target, "memory": "target"}])
    db.add_edge(source, target, "Mixed_case_1")
    assert db.get_edges(source) == [{"from": source, "to": target, "type": "Mixed_case_1"}]
    db.delete_edge(source, target, "Mixed_case_1")
    assert not db.edge_exists(source, target)
    db.add_edge(source, target, "Mixed_case_1")
    db.delete_node(source)
    assert db.get_node(source) is None
    assert db.get_node(target)["memory"] == "target"


@pytest.mark.parametrize("existing_edge", [False, True])
def test_age_concurrent_delete_and_edge_creation_leave_no_dangling_edges(
    stores, database, existing_edge
):
    db = stores()
    admin, _ = database
    db.add_nodes_batch([{"id": "one", "memory": "source"}, {"id": "two", "memory": "target"}])
    if existing_edge:
        db.add_edge("one", "two", "RELATE_TO")
    barrier = threading.Barrier(2)

    def change(delete):
        barrier.wait(timeout=5)
        if delete:
            db.delete_node("one")
        else:
            db.add_edge("one", "two", "RELATE_TO")

    with ThreadPoolExecutor(2) as executor:
        list(executor.map(change, [True, False]))
    assert db.get_node("one") is None
    assert db.get_node("two") == {"id": "two", "memory": "target", "metadata": {}}
    assert db.get_edges("two") == []
    assert _query(admin, "SELECT count(*) FROM memos_graph._ag_label_edge") == [(0,)]


def test_age_maximum_type_length_and_native_graph_after_sql_delete(stores, database):
    db = stores()
    admin, _ = database
    db.add_nodes_batch([{"id": "one", "memory": "source"}, {"id": "two", "memory": "target"}])
    edge_type = "R" * 63
    db.add_edge("one", "two", edge_type)
    assert db.get_edges("one", edge_type) == [{"from": "one", "to": "two", "type": edge_type}]
    db.delete_node("one")
    assert _query(
        admin,
        "SELECT * FROM ag_catalog.cypher('memos_graph',$$MATCH (n:Memory) RETURN n.id$$) AS (id agtype)",
    ) == [('"two"',)]
    db.add_node("one", "recreated", {})
    assert db.get_edges("one") == []
    db.add_edge("one", "two", edge_type)
    assert db.edge_exists("one", "two", edge_type)


def _traversal_fixture(db):
    db.add_nodes_batch([{"id": name, "memory": "memory " + name} for name in [*"abcdefg", "z"]])
    db.add_nodes_batch([{"id": name, "memory": "B " + name} for name in "abcdefg"], user_name="B")
    for source, target, kind in [
        ("a", "b", "R"),
        ("a", "c", "R"),
        ("b", "d", "R"),
        ("c", "d", "R"),
        ("d", "a", "R"),
        ("e", "a", "R"),
        ("b", "c", "SIDE"),
        ("a", "b", "OTHER"),
        ("b", "b", "SELF"),
        ("d", "f", "R"),
        ("f", "g", "R"),
    ]:
        db.add_edge(source, target, kind)
    db.add_edge("a", "g", "R", user_name="B")


@pytest.mark.parametrize(
    "source,target,depth,expected",
    [
        ("a", "d", 1, []),
        ("a", "d", 2, ["a", "b", "d"]),
        ("a", "g", 3, []),
        ("a", "g", 4, ["a", "b", "d", "f", "g"]),
        ("a", "a", 1, ["a"]),
        ("a", "e", 5, []),
        ("a", "z", 5, []),
        ("missing", "a", 3, []),
        ("a", "missing", 3, []),
        ("missing", "missing", 3, []),
    ],
)
def test_age_bounded_shortest_path(stores, source, target, depth, expected):
    db = stores()
    _traversal_fixture(db)
    assert db.get_path(source, target, depth) == expected
    assert db.get_path("a", "g", 1, user_name="B") == ["a", "g"]


def test_age_traversal_reaches_fifth_hop_and_stops_at_configured_bound(stores):
    db = stores()
    db.add_nodes_batch([{"id": str(i), "memory": str(i)} for i in range(7)])
    for i in range(6):
        db.add_edge(str(i), str(i + 1), "R")
    db.add_edge("6", "0", "R")
    assert db.get_path("0", "5", 5) == ["0", "1", "2", "3", "4", "5"]
    assert db.get_path("0", "6", 5) == []
    assert [n["id"] for n in db.get_subgraph("0", 1)["neighbors"]] == ["1", "6"]
    with pytest.raises(ValueError, match="depth"):
        db.get_path("0", "6", 6)
    with pytest.raises(ValueError, match="depth"):
        db.get_subgraph("0", 0)


def test_age_subgraph_preserves_full_nodes_and_induced_edge_shape(stores, database):
    db = stores()
    _traversal_fixture(db)
    result = db.get_subgraph("a", 1)
    assert result == {
        "core_node": {"id": "a", "memory": "memory a", "metadata": {}},
        "neighbors": [
            {"id": name, "memory": "memory " + name, "metadata": {}}
            for name in ["b", "c", "d", "e"]
        ],
        "edges": [
            {"source": "a", "target": "b", "type": "OTHER"},
            {"source": "a", "target": "b", "type": "R"},
            {"source": "a", "target": "c", "type": "R"},
            {"source": "b", "target": "b", "type": "SELF"},
            {"source": "b", "target": "c", "type": "SIDE"},
            {"source": "b", "target": "d", "type": "R"},
            {"source": "c", "target": "d", "type": "R"},
            {"source": "d", "target": "a", "type": "R"},
            {"source": "e", "target": "a", "type": "R"},
        ],
    }
    assert [n["id"] for n in db.get_subgraph("a", 2)["neighbors"]] == ["b", "c", "d", "e", "f"]
    assert db.get_subgraph("z") == {
        "core_node": {"id": "z", "memory": "memory z", "metadata": {}},
        "neighbors": [],
        "edges": [],
    }
    admin, _ = database
    assert _query(admin, 'SELECT count(*) FROM memos_graph."Memory"') == [(15,)]
    assert _query(admin, "SELECT count(*) FROM memos_graph._ag_label_edge") == [(12,)]


def test_age_subgraph_center_status_and_missing_center(stores):
    db = stores()
    db.add_node("a", "center", {"status": "archived", "embedding": [1, 0, 0]})
    db.add_node("b", "neighbor", {"status": "deleted", "info": {"nested": [1]}})
    db.add_edge("a", "b", "R")
    empty = {"core_node": None, "neighbors": [], "edges": []}
    assert db.get_subgraph("missing") == db.get_subgraph("a") == empty
    for status in ("archived", "", None):
        assert db.get_subgraph("a", center_status=status) == {
            "core_node": {"id": "a", "memory": "center", "metadata": {"status": "archived"}},
            "neighbors": [
                {
                    "id": "b",
                    "memory": "neighbor",
                    "metadata": {"status": "deleted", "info": {"nested": [1]}},
                }
            ],
            "edges": [{"source": "a", "target": "b", "type": "R"}],
        }


def test_age_traversal_cannot_bridge_scopes_through_external_edges(stores, database):
    db = stores()
    _traversal_fixture(db)
    admin, _ = database
    _query(
        admin,
        "SELECT * FROM ag_catalog.cypher('memos_graph',$$"
        "MATCH (a:Memory {id:'a',user_name:'A'}),(b:Memory {id:'b',user_name:'B'}),"
        "(z:Memory {id:'z',user_name:'A'}) CREATE (a)-[:BRIDGE]->(b)-[:BRIDGE]->(z)"
        "$$) AS (result agtype)",
    )
    assert db.get_path("a", "z", 5) == []
    assert [n["id"] for n in db.get_subgraph("a", 5)["neighbors"]] == list("bcdefg")
    assert all(e["type"] != "BRIDGE" for e in db.get_subgraph("a", 5)["edges"])


@pytest.mark.parametrize("physical", [False, True])
def test_age_traversal_preserves_special_ids_and_scope(stores, physical):
    scope = None if physical else " 范围 $memos$ ' \n"
    db = stores(use_multi_db=physical, user_name=scope)
    source, target = '"中文 $memos$ ; --\n"', "目标 $$ ' \\\n"
    db.add_node(source, "source", {"tags": ["标签 ' $$"]})
    db.add_node(target, "target", {"tags": ["标签 ' $$"]})
    db.add_edge(source, target, "R")
    assert db.get_path(source, target, 1) == [source, target]
    assert db.get_subgraph(source, 1)["edges"] == [
        {"source": source, "target": target, "type": "R"}
    ]
    assert [n["id"] for n in db.get_neighbors_by_tag(["标签 ' $$"], [target])] == [source]


def test_age_tag_neighbors_rank_visibility_and_optional_embeddings(stores):
    db = stores()
    for node_id, metadata in [
        ("b", {"tags": ["red", "blue", "blue"]}),
        ("a", {"tags": '["red", "blue"]', "embedding": [1, 0, 0]}),
        ("c", {"tags": ["red"]}),
        ("archive", {"status": "archived", "tags": ["red"]}),
        ("reason", {"type": "reasoning", "tags": ["red"]}),
        ("legacy", {"node_type": "reasoning", "tags": ["red"]}),
        ("working", {"memory_type": "WorkingMemory", "tags": ["red"]}),
        ("empty", {"tags": None}),
    ]:
        db.add_node(node_id, "memory " + node_id, metadata)
    db.add_node("foreign", "B", {"tags": ["red", "blue"]}, user_name="B")
    assert db.get_neighbors_by_tag(["red", "blue", "red"], [], top_k=2) == [
        {"id": "a", "memory": "memory a", "metadata": {"tags": '["red", "blue"]'}},
        {"id": "b", "memory": "memory b", "metadata": {"tags": ["red", "blue", "blue"]}},
    ]
    assert [n["id"] for n in db.get_neighbors_by_tag(["red"], ["a"])] == ["b", "c"]
    assert db.get_neighbors_by_tag(["red", "red"], [], min_overlap=2) == []
    assert db.get_neighbors_by_tag(["blue"], [], top_k=1, include_embedding=True)[0]["metadata"][
        "embedding"
    ] == [1, 0, 0]
    assert db.get_neighbors_by_tag(["red"], [], user_name="B") == [
        {"id": "foreign", "memory": "B", "metadata": {"tags": ["red", "blue"]}}
    ]
    assert (
        db.get_neighbors_by_tag(["red"], ["a"], include_embedding=True)[0]["metadata"]["embedding"]
        is None
    )


@pytest.mark.parametrize(
    "method,args",
    [
        ("get_path", ("a", "b")),
        ("get_subgraph", ("a",)),
        ("get_neighbors_by_tag", (["red"], [])),
    ],
)
def test_age_traversal_select_failure_rolls_back_and_recovers(stores, database, method, args):
    db = stores(maxconn=1)
    db.add_node("a", "center", {"tags": ["red"]})
    db.add_node("b", "neighbor", {})
    db.add_edge("a", "b", "R")
    admin, config = database
    _query(
        admin,
        sql.SQL('REVOKE SELECT ON memos_graph."Memory" FROM {}').format(
            sql.Identifier(config.user)
        ),
    )
    try:
        with pytest.raises(GraphDBError) as error:
            getattr(db, method)(*args)
        assert error.value.__cause__.pgcode == "42501"
    finally:
        _query(
            admin,
            sql.SQL('GRANT SELECT ON memos_graph."Memory" TO {}').format(
                sql.Identifier(config.user)
            ),
        )
    assert db.get_path("a", "b") == ["a", "b"]
    assert db.get_subgraph("a")["neighbors"] == [{"id": "b", "memory": "neighbor", "metadata": {}}]
    assert db.get_neighbors_by_tag(["red"], []) == [
        {"id": "a", "memory": "center", "metadata": {"tags": ["red"]}}
    ]


def test_age_bad_tag_data_fails_without_poisoning_the_connection(stores):
    db = stores(maxconn=1)
    db.add_node("a", "invalid tags", {"tags": "not-json"})
    with pytest.raises(GraphDBError, match="tags"):
        db.get_neighbors_by_tag(["red"], [])
    db.update_node("a", {"tags": ["red"]})
    assert db.get_neighbors_by_tag(["red"], []) == [
        {"id": "a", "memory": "invalid tags", "metadata": {"tags": ["red"]}}
    ]
