"""Module-level utility functions for PolarDB graph database."""

import random


def generate_vector(dim=1024, low=-0.2, high=0.2):
    """Generate a random vector for testing purposes."""
    return [round(random.uniform(low, high), 6) for _ in range(dim)]


def escape_sql_string(value: str) -> str:
    """Escape single quotes in SQL string."""
    return value.replace("'", "''")
