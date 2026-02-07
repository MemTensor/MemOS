import time

from memos.graph_dbs.utils import convert_to_vector
from memos.log import get_logger
from memos.utils import timed

logger = get_logger(__name__)


class SearchMixin:
    """Mixin for search operations (keyword, fulltext, embedding)."""

    def _build_search_where_clauses_sql(
        self,
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
    ) -> list[str]:
        """Build common WHERE clauses for SQL-based search methods."""
        where_clauses = []

        if scope:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"memory_type\"'::agtype) = '\"{scope}\"'::agtype"
            )
        if status:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"status\"'::agtype) = '\"{status}\"'::agtype"
            )
        else:
            where_clauses.append(
                "ag_catalog.agtype_access_operator(properties::text::agtype, '\"status\"'::agtype) = '\"activated\"'::agtype"
            )

        # Build user_name filter with knowledgebase_ids support (OR relationship)
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_sql(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self.config.user_name,
        )
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Add search_filter conditions
        if search_filter:
            for key, value in search_filter.items():
                if isinstance(value, str):
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"{key}\"'::agtype) = '\"{value}\"'::agtype"
                    )
                else:
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"{key}\"'::agtype) = {value}::agtype"
                    )

        # Build filter conditions
        filter_conditions = self._build_filter_conditions_sql(filter)
        where_clauses.extend(filter_conditions)

        return where_clauses

    @timed
    def search_by_keywords_like(
        self,
        query_word: str,
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        where_clauses = self._build_search_where_clauses_sql(
            scope=scope, status=status, search_filter=search_filter,
            user_name=user_name, filter=filter, knowledgebase_ids=knowledgebase_ids,
        )

        # Method-specific: LIKE pattern match
        where_clauses.append("""(properties -> '"memory"')::text LIKE %s""")
        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        query = f"""
            SELECT
                ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) AS old_id,
                agtype_object_field_text(properties, 'memory') as memory_text
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
            """

        params = (query_word,)
        logger.info(
            f"[search_by_keywords_LIKE start:]  user_name: {user_name}, query: {query}, params: {params}"
        )
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()
                output = []
                for row in results:
                    oldid = row[0]
                    id_val = str(oldid).strip('"')
                    output.append({"id": id_val})
                logger.info(
                    f"[search_by_keywords_LIKE end:] user_name: {user_name}, query: {query}, params: {params} recalled: {output}"
                )
                return output
        finally:
            self._return_connection(conn)

    @timed
    def search_by_keywords_tfidf(
        self,
        query_words: list[str],
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        tsvector_field: str = "properties_tsvector_zh",
        tsquery_config: str = "jiebaqry",
        **kwargs,
    ) -> list[dict]:
        where_clauses = self._build_search_where_clauses_sql(
            scope=scope, status=status, search_filter=search_filter,
            user_name=user_name, filter=filter, knowledgebase_ids=knowledgebase_ids,
        )

        # Method-specific: TF-IDF fulltext search condition
        tsquery_string = " | ".join(query_words)
        where_clauses.append(f"{tsvector_field} @@ to_tsquery('{tsquery_config}', %s)")

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        query = f"""
            SELECT
                ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) AS old_id,
                agtype_object_field_text(properties, 'memory') as memory_text
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
        """

        params = (tsquery_string,)
        logger.info(
            f"[search_by_keywords_TFIDF start:] user_name: {user_name}, query: {query}, params: {params}"
        )
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()
                output = []
                for row in results:
                    oldid = row[0]
                    id_val = str(oldid).strip('"')
                    output.append({"id": id_val})

                logger.info(
                    f"[search_by_keywords_TFIDF end:] user_name: {user_name}, query: {query}, params: {params} recalled: {output}"
                )
                return output
        finally:
            self._return_connection(conn)

    @timed
    def search_by_fulltext(
        self,
        query_words: list[str],
        top_k: int = 10,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        tsvector_field: str = "properties_tsvector_zh",
        tsquery_config: str = "jiebacfg",
        **kwargs,
    ) -> list[dict]:
        """
        Full-text search functionality using PostgreSQL's full-text search capabilities.

        Args:
            query_text: query text
            top_k: maximum number of results to return
            scope: memory type filter (memory_type)
            status: status filter, defaults to "activated"
            threshold: similarity threshold filter
            search_filter: additional property filter conditions
            user_name: username filter
            knowledgebase_ids: knowledgebase ids filter
            filter: filter conditions with 'and' or 'or' logic for search results.
            tsvector_field: full-text index field name, defaults to properties_tsvector_zh_1
            tsquery_config: full-text search configuration, defaults to jiebaqry (Chinese word segmentation)
            **kwargs: other parameters (e.g. cube_name)

        Returns:
            list[dict]: result list containing id and score
        """
        logger.info(
            f"[search_by_fulltext] query_words: {query_words}, top_k: {top_k}, scope: {scope}, filter: {filter}"
        )
        start_time = time.time()
        where_clauses = self._build_search_where_clauses_sql(
            scope=scope, status=status, search_filter=search_filter,
            user_name=user_name, filter=filter, knowledgebase_ids=knowledgebase_ids,
        )

        # Method-specific: fulltext search condition
        tsquery_string = " | ".join(query_words)

        where_clauses.append(f"{tsvector_field} @@ to_tsquery('{tsquery_config}', %s)")

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        logger.info(f"[search_by_fulltext] where_clause: {where_clause}")

        # Build fulltext search query
        query = f"""
            SELECT
                ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) AS old_id,
                agtype_object_field_text(properties, 'memory') as memory_text,
                ts_rank({tsvector_field}, to_tsquery('{tsquery_config}', %s)) as rank
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
            ORDER BY rank DESC
            LIMIT {top_k};
        """

        params = [tsquery_string, tsquery_string]
        logger.info(f"[search_by_fulltext] query: {query}, params: {params}")
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()
                output = []
                for row in results:
                    oldid = row[0]  # old_id
                    rank = row[2]  # rank score

                    id_val = str(oldid).strip('"')
                    score_val = float(rank)

                    # Apply threshold filter if specified
                    if threshold is None or score_val >= threshold:
                        output.append({"id": id_val, "score": score_val})
                elapsed_time = time.time() - start_time
                logger.info(
                    f" polardb [search_by_fulltext] query completed time in {elapsed_time:.2f}s"
                )
                return output[:top_k]
        finally:
            self._return_connection(conn)

    @timed
    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """
        Retrieve node IDs based on vector similarity using PostgreSQL vector operations.
        """
        logger.info(
            f"[search_by_embedding] filter: {filter}, knowledgebase_ids: {knowledgebase_ids}"
        )
        where_clauses = self._build_search_where_clauses_sql(
            scope=scope, status=status, search_filter=search_filter,
            user_name=user_name, filter=filter, knowledgebase_ids=knowledgebase_ids,
        )
        # Method-specific: require embedding column
        where_clauses.append("embedding is not null")

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Keep original simple query structure but add dynamic WHERE clause
        query = f"""
                    WITH t AS (
                        SELECT id,
                               properties,
                               timeline,
                               ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) AS old_id,
                               (1 - (embedding <=> %s::vector(1024))) AS scope
                        FROM "{self.db_name}_graph"."Memory"
                        {where_clause}
                        ORDER BY scope DESC
                        LIMIT {top_k}
                    )
                    SELECT *
                    FROM t
                    WHERE scope > 0.1;
                """
        # Convert vector to string format for PostgreSQL vector type
        # PostgreSQL vector type expects a string format like '[1,2,3]'
        vector_str = convert_to_vector(vector)
        # Use string format directly in query instead of parameterized query
        # Replace %s with the vector string, but need to quote it properly
        # PostgreSQL vector type needs the string to be quoted
        query = query.replace("%s::vector(1024)", f"'{vector_str}'::vector(1024)")
        params = []

        logger.info(f"[search_by_embedding] query: {query}, params: {params}")

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                try:
                    # If params is empty, execute query directly without parameters
                    if params:
                        cursor.execute(query, params)
                    else:
                        cursor.execute(query)
                except Exception as e:
                    logger.error(f"[search_by_embedding] Error executing query: {e}")
                    raise
                results = cursor.fetchall()
                output = []
                for row in results:
                    if len(row) < 5:
                        logger.warning(f"Row has {len(row)} columns, expected 5. Row: {row}")
                        continue
                    oldid = row[3]  # old_id
                    score = row[4]  # scope
                    id_val = str(oldid).strip('"')
                    score_val = float(score)
                    score_val = (score_val + 1) / 2  # align to neo4j, Normalized Cosine Score
                    if threshold is None or score_val >= threshold:
                        output.append({"id": id_val, "score": score_val})
                return output[:top_k]
        except Exception as e:
            logger.error(f"[search_by_embedding] Error: {type(e).__name__}: {e}", exc_info=True)
            return []
        finally:
            self._return_connection(conn)

    # Backward-compatible aliases for renamed methods (typo -> correct)
    seach_by_keywords_like = search_by_keywords_like
    seach_by_keywords_tfidf = search_by_keywords_tfidf
