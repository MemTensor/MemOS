"""PolarDB graph database package using Apache AGE extension."""

from memos.graph_dbs.polardb.connection import ConnectionMixin
from memos.graph_dbs.polardb.edges import EdgeMixin
from memos.graph_dbs.polardb.filters import FilterMixin
from memos.graph_dbs.polardb.maintenance import MaintenanceMixin
from memos.graph_dbs.polardb.nodes import NodeMixin
from memos.graph_dbs.polardb.queries import QueryMixin
from memos.graph_dbs.polardb.schema import SchemaMixin
from memos.graph_dbs.polardb.search import SearchMixin
from memos.graph_dbs.polardb.traversal import TraversalMixin
from memos.graph_dbs.base import BaseGraphDB


class PolarDBGraphDB(
    ConnectionMixin,
    SchemaMixin,
    NodeMixin,
    EdgeMixin,
    TraversalMixin,
    SearchMixin,
    FilterMixin,
    QueryMixin,
    MaintenanceMixin,
    BaseGraphDB,
):
    """PolarDB-based graph database using Apache AGE extension."""

    pass
