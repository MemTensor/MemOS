import json

from typing import Any, Literal

from memos.log import get_logger


logger = get_logger(__name__)


class FilterMixin:
    """Mixin for filter condition building (WHERE clause builders)."""

    def _build_user_name_and_kb_ids_conditions(
        self,
        user_name: str | None,
        knowledgebase_ids: list | None,
        default_user_name: str | None = None,
        mode: Literal["cypher", "sql"] = "sql",
    ) -> list[str]:
        """
        Build user_name and knowledgebase_ids conditions.

        Args:
            user_name: User name for filtering
            knowledgebase_ids: List of knowledgebase IDs
            default_user_name: Default user name from config if user_name is None
            mode: 'cypher' for Cypher property access, 'sql' for AgType SQL access

        Returns:
            List of condition strings (will be joined with OR)
        """
        user_name_conditions = []
        effective_user_name = user_name if user_name else default_user_name

        def _fmt(value: str) -> str:
            if mode == "cypher":
                escaped = value.replace("'", "''")
                return f"n.user_name = '{escaped}'"
            return (
                f"ag_catalog.agtype_access_operator(properties::text::agtype, "
                f"'\"user_name\"'::agtype) = '\"{value}\"'::agtype"
            )

        if effective_user_name:
            user_name_conditions.append(_fmt(effective_user_name))

        if knowledgebase_ids and isinstance(knowledgebase_ids, list) and len(knowledgebase_ids) > 0:
            for kb_id in knowledgebase_ids:
                if isinstance(kb_id, str):
                    user_name_conditions.append(_fmt(kb_id))

        return user_name_conditions

    def _build_user_name_and_kb_ids_conditions_cypher(
        self, user_name, knowledgebase_ids, default_user_name=None
    ):
        return self._build_user_name_and_kb_ids_conditions(
            user_name, knowledgebase_ids, default_user_name, mode="cypher"
        )

    def _build_user_name_and_kb_ids_conditions_sql(
        self, user_name, knowledgebase_ids, default_user_name=None
    ):
        return self._build_user_name_and_kb_ids_conditions(
            user_name, knowledgebase_ids, default_user_name, mode="sql"
        )

    def _build_filter_conditions(
        self,
        filter: dict | None,
        mode: Literal["cypher", "sql"] = "sql",
    ) -> str | list[str]:
        """
        Build filter conditions for Cypher or SQL queries.

        Args:
            filter: Filter dictionary with "or" or "and" logic
            mode: "cypher" for Cypher queries, "sql" for SQL queries

        Returns:
            For mode="cypher": Filter WHERE clause string with " AND " prefix (empty string if no filter)
            For mode="sql": List of filter WHERE clause strings (empty list if no filter)
        """
        is_cypher = mode == "cypher"
        filter = self.parse_filter(filter)

        if not filter:
            return "" if is_cypher else []

        # --- Dialect helpers ---

        def escape_string(value: str) -> str:
            if is_cypher:
                # Backslash escape for single quotes inside $$ dollar-quoted strings
                return value.replace("'", "\\'")
            else:
                return value.replace("'", "''")

        def prop_direct(key: str) -> str:
            """Property access expression for a direct (top-level) key."""
            if is_cypher:
                return f"n.{key}"
            else:
                return f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"{key}\"'::agtype)"

        def prop_nested(info_field: str) -> str:
            """Property access expression for a nested info.field key."""
            if is_cypher:
                return f"n.info.{info_field}"
            else:
                return f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties::text::agtype, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype])"

        def prop_ref(key: str) -> str:
            """Return the appropriate property access expression for a key (direct or nested)."""
            if key.startswith("info."):
                return prop_nested(key[5:])
            return prop_direct(key)

        def fmt_str_val(escaped_value: str) -> str:
            """Format an escaped string value as a literal."""
            if is_cypher:
                return f"'{escaped_value}'"
            else:
                return f"'\"{escaped_value}\"'::agtype"

        def fmt_non_str_val(value: Any) -> str:
            """Format a non-string value as a literal."""
            if is_cypher:
                return str(value)
            else:
                value_json = json.dumps(value)
                return f"ag_catalog.agtype_in('{value_json}')"

        def fmt_array_eq_single_str(escaped_value: str) -> str:
            """Format an array-equality check for a single string value: field = ['val']."""
            if is_cypher:
                return f"['{escaped_value}']"
            else:
                return f"'[\"{escaped_value}\"]'::agtype"

        def fmt_array_eq_list(items: list, escape_fn) -> str:
            """Format an array-equality check for a list of values."""
            if is_cypher:
                escaped_items = [f"'{escape_fn(str(item))}'" for item in items]
                return "[" + ", ".join(escaped_items) + "]"
            else:
                escaped_items = [escape_fn(str(item)) for item in items]
                json_array = json.dumps(escaped_items)
                return f"'{json_array}'::agtype"

        def fmt_array_eq_non_str(value: Any) -> str:
            """Format an array-equality check for a single non-string value: field = [val]."""
            if is_cypher:
                return f"[{value}]"
            else:
                return f"'[{value}]'::agtype"

        def fmt_contains_str(escaped_value: str, prop_expr: str) -> str:
            """Format a 'contains' check: array field contains a string value."""
            if is_cypher:
                return f"'{escaped_value}' IN {prop_expr}"
            else:
                return f"{prop_expr} @> '[\"{escaped_value}\"]'::agtype"

        def fmt_contains_non_str(value: Any, prop_expr: str) -> str:
            """Format a 'contains' check: array field contains a non-string value."""
            if is_cypher:
                return f"{value} IN {prop_expr}"
            else:
                escaped_value = str(value).replace("'", "''")
                return f"{prop_expr} @> '[\"{escaped_value}\"]'::agtype"

        def fmt_like(escaped_value: str, prop_expr: str) -> str:
            """Format a 'like' (fuzzy match) check."""
            if is_cypher:
                return f"{prop_expr} CONTAINS '{escaped_value}'"
            else:
                return f"{prop_expr}::text LIKE '%{escaped_value}%'"

        def fmt_datetime_cmp(prop_expr: str, cmp_op: str, escaped_value: str) -> str:
            """Format a datetime comparison."""
            if is_cypher:
                return f"{prop_expr}::timestamp {cmp_op} '{escaped_value}'::timestamp"
            else:
                return f"TRIM(BOTH '\"' FROM {prop_expr}::text)::timestamp {cmp_op} '{escaped_value}'::timestamp"

        def fmt_in_scalar_eq_str(escaped_value: str, prop_expr: str) -> str:
            """Format scalar equality for 'in' operator with a string item."""
            return f"{prop_expr} = {fmt_str_val(escaped_value)}"

        def fmt_in_scalar_eq_non_str(item: Any, prop_expr: str) -> str:
            """Format scalar equality for 'in' operator with a non-string item."""
            if is_cypher:
                return f"{prop_expr} = {item}"
            else:
                return f"{prop_expr} = {item}::agtype"

        def fmt_in_array_contains_str(escaped_value: str, prop_expr: str) -> str:
            """Format array-contains for 'in' operator with a string item."""
            if is_cypher:
                return f"'{escaped_value}' IN {prop_expr}"
            else:
                return f"{prop_expr} @> '[\"{escaped_value}\"]'::agtype"

        def fmt_in_array_contains_non_str(item: Any, prop_expr: str) -> str:
            """Format array-contains for 'in' operator with a non-string item."""
            if is_cypher:
                return f"{item} IN {prop_expr}"
            else:
                escaped_value = str(item).replace("'", "''")
                return f"{prop_expr} @> '[\"{escaped_value}\"]'::agtype"

        def escape_like_value(value: str) -> str:
            """Escape a value for use in like/CONTAINS. SQL needs extra LIKE-char escaping."""
            escaped = escape_string(value)
            if not is_cypher:
                escaped = escaped.replace("%", "\\%").replace("_", "\\_")
            return escaped

        def fmt_scalar_in_clause(items: list, prop_expr: str) -> str:
            """Format a scalar IN clause for multiple values (cypher only has this path)."""
            if is_cypher:
                escaped_items = [
                    f"'{escape_string(str(item))}'" if isinstance(item, str) else str(item)
                    for item in items
                ]
                array_str = "[" + ", ".join(escaped_items) + "]"
                return f"{prop_expr} IN {array_str}"
            else:
                # SQL mode: use OR equality conditions
                or_parts = []
                for item in items:
                    if isinstance(item, str):
                        escaped_value = escape_string(item)
                        or_parts.append(f"{prop_expr} = {fmt_str_val(escaped_value)}")
                    else:
                        or_parts.append(f"{prop_expr} = {item}::agtype")
                return f"({' OR '.join(or_parts)})"

        # --- Main condition builder ---

        def build_filter_condition(condition_dict: dict) -> str:
            """Build a WHERE condition for a single filter item."""
            condition_parts = []
            for key, value in condition_dict.items():
                is_info = key.startswith("info.")
                info_field = key[5:] if is_info else None
                prop_expr = prop_ref(key)

                # Check if value is a dict with comparison operators
                if isinstance(value, dict):
                    for op, op_value in value.items():
                        if op in ("gt", "lt", "gte", "lte"):
                            cmp_op_map = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
                            cmp_op = cmp_op_map[op]

                            # Determine if this is a datetime field
                            field_name = info_field if is_info else key
                            is_dt = field_name in (
                                "created_at",
                                "updated_at",
                            ) or field_name.endswith("_at")

                            if isinstance(op_value, str):
                                escaped_value = escape_string(op_value)
                                if is_dt:
                                    condition_parts.append(
                                        fmt_datetime_cmp(prop_expr, cmp_op, escaped_value)
                                    )
                                else:
                                    condition_parts.append(
                                        f"{prop_expr} {cmp_op} {fmt_str_val(escaped_value)}"
                                    )
                            else:
                                condition_parts.append(
                                    f"{prop_expr} {cmp_op} {fmt_non_str_val(op_value)}"
                                )

                        elif op == "=":
                            # Equality operator
                            field_name = info_field if is_info else key
                            is_array_field = field_name in ("tags", "sources")

                            if isinstance(op_value, str):
                                escaped_value = escape_string(op_value)
                                if is_array_field:
                                    condition_parts.append(
                                        f"{prop_expr} = {fmt_array_eq_single_str(escaped_value)}"
                                    )
                                else:
                                    condition_parts.append(
                                        f"{prop_expr} = {fmt_str_val(escaped_value)}"
                                    )
                            elif isinstance(op_value, list):
                                if is_array_field:
                                    condition_parts.append(
                                        f"{prop_expr} = {fmt_array_eq_list(op_value, escape_string)}"
                                    )
                                else:
                                    if is_cypher:
                                        condition_parts.append(f"{prop_expr} = {op_value}")
                                    elif is_info:
                                        # Info nested field: use ::agtype cast
                                        condition_parts.append(f"{prop_expr} = {op_value}::agtype")
                                    else:
                                        # Direct field: convert to JSON string and then to agtype
                                        value_json = json.dumps(op_value)
                                        condition_parts.append(
                                            f"{prop_expr} = ag_catalog.agtype_in('{value_json}')"
                                        )
                            else:
                                if is_array_field:
                                    condition_parts.append(
                                        f"{prop_expr} = {fmt_array_eq_non_str(op_value)}"
                                    )
                                else:
                                    condition_parts.append(
                                        f"{prop_expr} = {fmt_non_str_val(op_value)}"
                                    )

                        elif op == "contains":
                            if isinstance(op_value, str):
                                escaped_value = escape_string(str(op_value))
                                condition_parts.append(fmt_contains_str(escaped_value, prop_expr))
                            else:
                                condition_parts.append(fmt_contains_non_str(op_value, prop_expr))

                        elif op == "in":
                            if not isinstance(op_value, list):
                                raise ValueError(
                                    f"in operator only supports array format. "
                                    f"Use {{'{key}': {{'in': ['{op_value}']}}}} instead of {{'{key}': {{'in': '{op_value}'}}}}"
                                )

                            field_name = info_field if is_info else key
                            is_arr = field_name in ("file_ids", "tags", "sources")

                            if len(op_value) == 0:
                                condition_parts.append("false")
                            elif len(op_value) == 1:
                                item = op_value[0]
                                if is_arr:
                                    if isinstance(item, str):
                                        escaped_value = escape_string(str(item))
                                        condition_parts.append(
                                            fmt_in_array_contains_str(escaped_value, prop_expr)
                                        )
                                    else:
                                        condition_parts.append(
                                            fmt_in_array_contains_non_str(item, prop_expr)
                                        )
                                else:
                                    if isinstance(item, str):
                                        escaped_value = escape_string(item)
                                        condition_parts.append(
                                            fmt_in_scalar_eq_str(escaped_value, prop_expr)
                                        )
                                    else:
                                        condition_parts.append(
                                            fmt_in_scalar_eq_non_str(item, prop_expr)
                                        )
                            else:
                                if is_arr:
                                    # For array fields, use OR conditions with contains
                                    or_conditions = []
                                    for item in op_value:
                                        if isinstance(item, str):
                                            escaped_value = escape_string(str(item))
                                            or_conditions.append(
                                                fmt_in_array_contains_str(escaped_value, prop_expr)
                                            )
                                        else:
                                            or_conditions.append(
                                                fmt_in_array_contains_non_str(item, prop_expr)
                                            )
                                    if or_conditions:
                                        condition_parts.append(f"({' OR '.join(or_conditions)})")
                                else:
                                    # For scalar fields
                                    if is_cypher:
                                        # Cypher uses IN clause with array literal
                                        condition_parts.append(
                                            fmt_scalar_in_clause(op_value, prop_expr)
                                        )
                                    else:
                                        # SQL uses OR equality conditions
                                        or_conditions = []
                                        for item in op_value:
                                            if isinstance(item, str):
                                                escaped_value = escape_string(item)
                                                or_conditions.append(
                                                    fmt_in_scalar_eq_str(escaped_value, prop_expr)
                                                )
                                            else:
                                                or_conditions.append(
                                                    fmt_in_scalar_eq_non_str(item, prop_expr)
                                                )
                                        if or_conditions:
                                            condition_parts.append(
                                                f"({' OR '.join(or_conditions)})"
                                            )

                        elif op == "like":
                            if isinstance(op_value, str):
                                escaped_value = escape_like_value(op_value)
                                condition_parts.append(fmt_like(escaped_value, prop_expr))
                            else:
                                if is_cypher:
                                    condition_parts.append(f"{prop_expr} CONTAINS {op_value}")
                                else:
                                    condition_parts.append(f"{prop_expr}::text LIKE '%{op_value}%'")

                # Simple equality (value is not a dict)
                elif is_info:
                    if isinstance(value, str):
                        escaped_value = escape_string(value)
                        condition_parts.append(f"{prop_expr} = {fmt_str_val(escaped_value)}")
                    else:
                        condition_parts.append(f"{prop_expr} = {fmt_non_str_val(value)}")
                else:
                    if isinstance(value, str):
                        escaped_value = escape_string(value)
                        condition_parts.append(f"{prop_expr} = {fmt_str_val(escaped_value)}")
                    else:
                        condition_parts.append(f"{prop_expr} = {fmt_non_str_val(value)}")
            return " AND ".join(condition_parts)

        # --- Assemble final result based on filter structure and mode ---

        if is_cypher:
            filter_where_clause = ""
            if isinstance(filter, dict):
                if "or" in filter:
                    or_conditions = []
                    for condition in filter["or"]:
                        if isinstance(condition, dict):
                            condition_str = build_filter_condition(condition)
                            if condition_str:
                                or_conditions.append(f"({condition_str})")
                    if or_conditions:
                        filter_where_clause = " AND " + f"({' OR '.join(or_conditions)})"
                elif "and" in filter:
                    and_conditions = []
                    for condition in filter["and"]:
                        if isinstance(condition, dict):
                            condition_str = build_filter_condition(condition)
                            if condition_str:
                                and_conditions.append(f"({condition_str})")
                    if and_conditions:
                        filter_where_clause = " AND " + " AND ".join(and_conditions)
                else:
                    condition_str = build_filter_condition(filter)
                    if condition_str:
                        filter_where_clause = " AND " + condition_str
            return filter_where_clause
        else:
            filter_conditions: list[str] = []
            if isinstance(filter, dict):
                if "or" in filter:
                    or_conditions = []
                    for condition in filter["or"]:
                        if isinstance(condition, dict):
                            condition_str = build_filter_condition(condition)
                            if condition_str:
                                or_conditions.append(f"({condition_str})")
                    if or_conditions:
                        filter_conditions.append(f"({' OR '.join(or_conditions)})")
                elif "and" in filter:
                    for condition in filter["and"]:
                        if isinstance(condition, dict):
                            condition_str = build_filter_condition(condition)
                            if condition_str:
                                filter_conditions.append(f"({condition_str})")
                else:
                    condition_str = build_filter_condition(filter)
                    if condition_str:
                        filter_conditions.append(condition_str)
            return filter_conditions

    def _build_filter_conditions_cypher(
        self,
        filter: dict | None,
    ) -> str:
        """
        Build filter conditions for Cypher queries.

        Args:
            filter: Filter dictionary with "or" or "and" logic

        Returns:
            Filter WHERE clause string (empty string if no filter)
        """
        return self._build_filter_conditions(filter, mode="cypher")

    def _build_filter_conditions_sql(
        self,
        filter: dict | None,
    ) -> list[str]:
        """
        Build filter conditions for SQL queries.

        Args:
            filter: Filter dictionary with "or" or "and" logic

        Returns:
            List of filter WHERE clause strings (empty list if no filter)
        """
        return self._build_filter_conditions(filter, mode="sql")

    def parse_filter(
        self,
        filter_dict: dict | None = None,
    ):
        if filter_dict is None:
            return None
        full_fields = {
            "id",
            "key",
            "tags",
            "type",
            "usage",
            "memory",
            "status",
            "sources",
            "user_id",
            "graph_id",
            "user_name",
            "background",
            "confidence",
            "created_at",
            "session_id",
            "updated_at",
            "memory_type",
            "node_type",
            "info",
            "source",
            "file_ids",
        }

        def process_condition(condition):
            if not isinstance(condition, dict):
                return condition

            new_condition = {}

            for key, value in condition.items():
                if key.lower() in ["or", "and"]:
                    if isinstance(value, list):
                        processed_items = []
                        for item in value:
                            if isinstance(item, dict):
                                processed_item = {}
                                for item_key, item_value in item.items():
                                    if item_key not in full_fields and not item_key.startswith(
                                        "info."
                                    ):
                                        new_item_key = f"info.{item_key}"
                                    else:
                                        new_item_key = item_key
                                    processed_item[new_item_key] = item_value
                                processed_items.append(processed_item)
                            else:
                                processed_items.append(item)
                        new_condition[key] = processed_items
                    else:
                        new_condition[key] = value
                else:
                    if key not in full_fields and not key.startswith("info."):
                        new_key = f"info.{key}"
                    else:
                        new_key = key

                    new_condition[new_key] = value

            return new_condition

        return process_condition(filter_dict)
