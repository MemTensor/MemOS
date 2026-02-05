"""
API Key Management Utilities.

Provides functions for generating, validating, and managing API keys.
"""

import hashlib
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass
class APIKey:
    """Represents a generated API key."""

    key: str  # Full key (only available at creation time)
    key_hash: str  # SHA-256 hash (stored in database)
    key_prefix: str  # First 12 chars for identification


def generate_api_key() -> APIKey:
    """
    Generate a new API key.

    Format: krlk_<64-hex-chars>

    Returns:
        APIKey with key, hash, and prefix
    """
    # Generate 32 random bytes = 64 hex chars
    random_bytes = secrets.token_bytes(32)
    hex_part = random_bytes.hex()

    key = f"krlk_{hex_part}"
    key_hash = hashlib.sha256(key.encode()).hexdigest()
    key_prefix = key[:12]

    return APIKey(key=key, key_hash=key_hash, key_prefix=key_prefix)


def hash_key(key: str) -> str:
    """Hash an API key using SHA-256."""
    return hashlib.sha256(key.encode()).hexdigest()


def validate_key_format(key: str) -> bool:
    """
    Validate API key format.

    Valid format: krlk_<64-hex-chars>
    """
    if not key or not isinstance(key, str):
        return False

    if not key.startswith("krlk_"):
        return False

    hex_part = key[5:]
    if len(hex_part) != 64:
        return False

    try:
        int(hex_part, 16)
        return True
    except ValueError:
        return False


def generate_master_key() -> tuple[str, str]:
    """
    Generate a master key for admin operations.

    Returns:
        Tuple of (key, hash)
    """
    random_bytes = secrets.token_bytes(32)
    key = f"mk_{random_bytes.hex()}"
    key_hash = hashlib.sha256(key.encode()).hexdigest()
    return key, key_hash


def create_api_key_in_db(
    conn,
    user_name: str,
    scopes: list[str] | None = None,
    description: str | None = None,
    expires_in_days: int | None = None,
    created_by: str | None = None,
) -> APIKey:
    """
    Create a new API key and store in database.

    Args:
        conn: Database connection
        user_name: Owner of the key
        scopes: List of scopes (default: ["read"])
        description: Human-readable description
        expires_in_days: Days until expiration (None = never)
        created_by: Who created this key

    Returns:
        APIKey with the generated key (only time it's available!)
    """
    api_key = generate_api_key()

    expires_at = None
    if expires_in_days:
        expires_at = datetime.utcnow() + timedelta(days=expires_in_days)

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO api_keys (key_hash, key_prefix, user_name, scopes, description, expires_at, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                api_key.key_hash,
                api_key.key_prefix,
                user_name,
                scopes or ["read"],
                description,
                expires_at,
                created_by,
            ),
        )
        conn.commit()

    return api_key


def revoke_api_key(conn, key_id: str) -> bool:
    """
    Revoke an API key by ID.

    Returns:
        True if key was revoked, False if not found
    """
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE api_keys SET is_active = false WHERE id = %s AND is_active = true",
            (key_id,),
        )
        conn.commit()
        return cur.rowcount > 0


def list_api_keys(conn, user_name: str | None = None) -> list[dict]:
    """
    List API keys (without exposing the actual keys).

    Args:
        conn: Database connection
        user_name: Filter by user (None = all users)

    Returns:
        List of key metadata dicts
    """
    with conn.cursor() as cur:
        if user_name:
            cur.execute(
                """
                SELECT id, key_prefix, user_name, scopes, description,
                       created_at, last_used_at, expires_at, is_active
                FROM api_keys
                WHERE user_name = %s
                ORDER BY created_at DESC
                """,
                (user_name,),
            )
        else:
            cur.execute(
                """
                SELECT id, key_prefix, user_name, scopes, description,
                       created_at, last_used_at, expires_at, is_active
                FROM api_keys
                ORDER BY created_at DESC
                """
            )

        rows = cur.fetchall()
        return [
            {
                "id": str(row[0]),
                "key_prefix": row[1],
                "user_name": row[2],
                "scopes": row[3],
                "description": row[4],
                "created_at": row[5].isoformat() if row[5] else None,
                "last_used_at": row[6].isoformat() if row[6] else None,
                "expires_at": row[7].isoformat() if row[7] else None,
                "is_active": row[8],
            }
            for row in rows
        ]
