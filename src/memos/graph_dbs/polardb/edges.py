import json
import time

from memos.log import get_logger
from memos.utils import timed


logger = get_logger(__name__)


class EdgeMixin:
    """Mixin for edge (relationship) operations."""

    @timed
    def create_edge(self):
        """Create all valid edge types if they do not exist"""

        valid_rel_types = {"AGGREGATE_TO", "FOLLOWS", "INFERS", "MERGED_TO", "RELATE_TO", "PARENT"}

        for label_name in valid_rel_types:
            conn = None
            logger.info(f"Creating elabel: {label_name}")
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(f"select create_elabel('{self.db_name}_graph', '{label_name}');")
                    logger.info(f"Successfully created elabel: {label_name}")
            except Exception as e:
                if "already exists" in str(e):
                    logger.info(f"Label '{label_name}' already exists, skipping.")
                else:
                    logger.warning(f"Failed to create label {label_name}: {e}")
                    logger.error(f"Failed to create elabel '{label_name}': {e}", exc_info=True)
            finally:
                self._return_connection(conn)

    @timed
    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        logger.info(
            f"polardb [add_edge] source_id: {source_id}, target_id: {target_id}, type: {type},user_name:{user_name}"
        )

        start_time = time.time()
        if not source_id or not target_id:
            logger.warning(f"Edge '{source_id}' and '{target_id}' are both None")
            raise ValueError("[add_edge] source_id and target_id must be provided")

        source_exists = self.get_node(source_id) is not None
        target_exists = self.get_node(target_id) is not None

        if not source_exists or not target_exists:
            logger.warning(
                "[add_edge] Source %s or target %s does not exist.", source_exists, target_exists
            )
            raise ValueError("[add_edge] source_id and target_id must be provided")

        properties = {}
        if user_name is not None:
            properties["user_name"] = user_name
        query = f"""
            INSERT INTO {self.db_name}_graph."Edges"(source_id, target_id, edge_type, properties)
            SELECT
                '{source_id}',
                '{target_id}',
                '{type}',
                jsonb_build_object('user_name', '{user_name}')
            WHERE NOT EXISTS (
                SELECT 1 FROM {self.db_name}_graph."Edges"
                WHERE source_id = '{source_id}'
                  AND target_id = '{target_id}'
                  AND edge_type = '{type}'
            );
        """
        logger.info(f"polardb [add_edge] query: {query}, properties: {json.dumps(properties)}")
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, (source_id, target_id, type, json.dumps(properties)))
                logger.info(f"Edge created: {source_id} -[{type}]-> {target_id}")

                elapsed_time = time.time() - start_time
                logger.info(f" polardb [add_edge] insert completed time in {elapsed_time:.2f}s")
        except Exception as e:
            logger.error(f"Failed to insert edge: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    @timed
    def delete_edge(self, source_id: str, target_id: str, type: str) -> None:
        """
        Delete a specific edge between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type to remove.
        """
        query = f"""
            DELETE FROM "{self.db_name}_graph"."Edges"
            WHERE source_id = %s AND target_id = %s AND edge_type = %s
        """
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, (source_id, target_id, type))
                logger.info(f"Edge deleted: {source_id} -[{type}]-> {target_id}")
        finally:
            self._return_connection(conn)

    @timed
    def edge_exists(
        self,
        source_id: str,
        target_id: str,
        type: str = "ANY",
        direction: str = "OUTGOING",
        user_name: str | None = None,
    ) -> bool:
        """
        Check if an edge exists between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type. Use "ANY" to match any relationship type.
            direction: Direction of the edge.
                       Use "OUTGOING" (default), "INCOMING", or "ANY".
            user_name (str, optional): User name for filtering in non-multi-db mode
        Returns:
            True if the edge exists, otherwise False.
        """

        # Prepare the relationship pattern
        user_name = user_name if user_name else self.config.user_name

        # Prepare the match pattern with direction
        if direction == "OUTGOING":
            pattern = "(a:Memory)-[r]->(b:Memory)"
        elif direction == "INCOMING":
            pattern = "(a:Memory)<-[r]-(b:Memory)"
        elif direction == "ANY":
            pattern = "(a:Memory)-[r]-(b:Memory)"
        else:
            raise ValueError(
                f"Invalid direction: {direction}. Must be 'OUTGOING', 'INCOMING', or 'ANY'."
            )
        query = f"SELECT * FROM cypher('{self.db_name}_graph', $$"
        query += f"\nMATCH {pattern}"
        query += f"\nWHERE a.user_name = '{user_name}' AND b.user_name = '{user_name}'"
        query += f"\nAND a.id = '{source_id}' AND b.id = '{target_id}'"
        if type != "ANY":
            query += f"\n AND type(r) = '{type}'"

        query += "\nRETURN r"
        query += "\n$$) AS (r agtype)"

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                result = cursor.fetchone()
                return result is not None and result[0] is not None
        finally:
            self._return_connection(conn)

    @timed
    def get_edges(
        self, id: str, type: str = "ANY", direction: str = "ANY", user_name: str | None = None
    ) -> list[dict[str, str]]:
        """
        Get edges connected to a node, with optional type and direction filter.

        Args:
            id: Node ID to retrieve edges for.
            type: Relationship type to match, or 'ANY' to match all.
            direction: 'OUTGOING', 'INCOMING', or 'ANY'.
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            List of edges:
            [
              {"from": "source_id", "to": "target_id", "type": "RELATE"},
              ...
            ]
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        if direction == "OUTGOING":
            pattern = "(a:Memory)-[r]->(b:Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "INCOMING":
            pattern = "(a:Memory)<-[r]-(b:Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "ANY":
            pattern = "(a:Memory)-[r]-(b:Memory)"
            where_clause = f"a.id = '{id}' OR b.id = '{id}'"
        else:
            raise ValueError("Invalid direction. Must be 'OUTGOING', 'INCOMING', or 'ANY'.")

        # Add type filter
        if type != "ANY":
            where_clause += f" AND type(r) = '{type}'"

        # Add user filter
        where_clause += f" AND a.user_name = '{user_name}' AND b.user_name = '{user_name}'"

        query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
            MATCH {pattern}
            WHERE {where_clause}
            RETURN a.id AS from_id, b.id AS to_id, type(r) AS edge_type
            $$) AS (from_id agtype, to_id agtype, edge_type agtype)
        """
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                edges = []
                for row in results:
                    # Extract and clean from_id
                    from_id_raw = row[0].value if hasattr(row[0], "value") else row[0]
                    if (
                        isinstance(from_id_raw, str)
                        and from_id_raw.startswith('"')
                        and from_id_raw.endswith('"')
                    ):
                        from_id = from_id_raw[1:-1]
                    else:
                        from_id = str(from_id_raw)

                    # Extract and clean to_id
                    to_id_raw = row[1].value if hasattr(row[1], "value") else row[1]
                    if (
                        isinstance(to_id_raw, str)
                        and to_id_raw.startswith('"')
                        and to_id_raw.endswith('"')
                    ):
                        to_id = to_id_raw[1:-1]
                    else:
                        to_id = str(to_id_raw)

                    # Extract and clean edge_type
                    edge_type_raw = row[2].value if hasattr(row[2], "value") else row[2]
                    if (
                        isinstance(edge_type_raw, str)
                        and edge_type_raw.startswith('"')
                        and edge_type_raw.endswith('"')
                    ):
                        edge_type = edge_type_raw[1:-1]
                    else:
                        edge_type = str(edge_type_raw)

                    edges.append({"from": from_id, "to": to_id, "type": edge_type})
                return edges

        except Exception as e:
            logger.error(f"Failed to get edges: {e}", exc_info=True)
            return []
        finally:
            self._return_connection(conn)
