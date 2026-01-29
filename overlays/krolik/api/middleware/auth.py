"""
API Key Authentication Middleware for MemOS.

Validates API keys and extracts user context for downstream handlers.
Keys are validated against SHA-256 hashes stored in PostgreSQL.
"""

import hashlib
import os
import time
from typing import Any

from fastapi import Depends, HTTPException, Request, Security
from fastapi.security import APIKeyHeader

import memos.log

logger = memos.log.get_logger(__name__)

# API key header configuration
API_KEY_HEADER = APIKeyHeader(name="Authorization", auto_error=False)

# Environment configuration
AUTH_ENABLED = os.getenv("AUTH_ENABLED", "false").lower() == "true"
MASTER_KEY_HASH = os.getenv("MASTER_KEY_HASH")  # SHA-256 hash of master key
INTERNAL_SERVICE_IPS = {"127.0.0.1", "::1", "memos-mcp", "moltbot", "clawdbot"}

# Connection pool for auth queries (lazy init)
_auth_pool = None


def _get_auth_pool():
    """Get or create auth database connection pool."""
    global _auth_pool
    if _auth_pool is not None:
        return _auth_pool

    try:
        import psycopg2.pool

        _auth_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=5,
            host=os.getenv("POSTGRES_HOST", "postgres"),
            port=int(os.getenv("POSTGRES_PORT", "5432")),
            user=os.getenv("POSTGRES_USER", "memos"),
            password=os.getenv("POSTGRES_PASSWORD", ""),
            dbname=os.getenv("POSTGRES_DB", "memos"),
            connect_timeout=10,
        )
        logger.info("Auth database pool initialized")
        return _auth_pool
    except Exception as e:
        logger.error(f"Failed to initialize auth pool: {e}")
        return None


def hash_api_key(key: str) -> str:
    """Hash an API key using SHA-256."""
    return hashlib.sha256(key.encode()).hexdigest()


def validate_key_format(key: str) -> bool:
    """Validate API key format: krlk_<64-hex>."""
    if not key or not key.startswith("krlk_"):
        return False
    hex_part = key[5:]  # Remove 'krlk_' prefix
    if len(hex_part) != 64:
        return False
    try:
        int(hex_part, 16)
        return True
    except ValueError:
        return False


def get_key_prefix(key: str) -> str:
    """Extract prefix for key identification (first 12 chars)."""
    return key[:12] if len(key) >= 12 else key


async def lookup_api_key(key_hash: str) -> dict[str, Any] | None:
    """
    Look up API key in database.

    Returns dict with user_name, scopes, etc. or None if not found.
    """
    pool = _get_auth_pool()
    if not pool:
        logger.warning("Auth pool not available, cannot validate key")
        return None

    conn = None
    try:
        conn = pool.getconn()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, user_name, scopes, expires_at, is_active
                FROM api_keys
                WHERE key_hash = %s
                """,
                (key_hash,),
            )
            row = cur.fetchone()

            if not row:
                return None

            key_id, user_name, scopes, expires_at, is_active = row

            # Check if key is active
            if not is_active:
                logger.warning(f"Inactive API key used: {key_hash[:16]}...")
                return None

            # Check expiration
            if expires_at and expires_at < time.time():
                logger.warning(f"Expired API key used: {key_hash[:16]}...")
                return None

            # Update last_used_at
            cur.execute(
                "UPDATE api_keys SET last_used_at = NOW() WHERE id = %s",
                (key_id,),
            )
            conn.commit()

            return {
                "id": str(key_id),
                "user_name": user_name,
                "scopes": scopes or ["read"],
            }
    except Exception as e:
        logger.error(f"Database error during key lookup: {e}")
        return None
    finally:
        if conn and pool:
            pool.putconn(conn)


def is_internal_request(request: Request) -> bool:
    """Check if request is from internal service."""
    client_host = request.client.host if request.client else None

    # Check internal IPs
    if client_host in INTERNAL_SERVICE_IPS:
        return True

    # Check internal header (for container-to-container)
    internal_header = request.headers.get("X-Internal-Service")
    if internal_header == os.getenv("INTERNAL_SERVICE_SECRET"):
        return True

    return False


async def verify_api_key(
    request: Request,
    api_key: str | None = Security(API_KEY_HEADER),
) -> dict[str, Any]:
    """
    Verify API key and return user context.

    This is the main dependency for protected endpoints.

    Returns:
        dict with user_name, scopes, and is_master_key flag

    Raises:
        HTTPException 401 if authentication fails
    """
    # Skip auth if disabled
    if not AUTH_ENABLED:
        return {
            "user_name": request.headers.get("X-User-Name", "default"),
            "scopes": ["all"],
            "is_master_key": False,
            "auth_bypassed": True,
        }

    # Allow internal services
    if is_internal_request(request):
        logger.debug(f"Internal request from {request.client.host}")
        return {
            "user_name": "internal",
            "scopes": ["all"],
            "is_master_key": False,
            "is_internal": True,
        }

    # Require API key
    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="Missing API key",
            headers={"WWW-Authenticate": "ApiKey"},
        )

    # Handle "Bearer" or "Token" prefix
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:]
    elif api_key.lower().startswith("token "):
        api_key = api_key[6:]

    # Check against master key first (has different format: mk_*)
    key_hash = hash_api_key(api_key)
    if MASTER_KEY_HASH and key_hash == MASTER_KEY_HASH:
        logger.info("Master key authentication")
        return {
            "user_name": "admin",
            "scopes": ["all"],
            "is_master_key": True,
        }

    # Validate format for regular API keys (krlk_*)
    if not validate_key_format(api_key):
        raise HTTPException(
            status_code=401,
            detail="Invalid API key format",
        )

    # Look up in database
    key_data = await lookup_api_key(key_hash)
    if not key_data:
        logger.warning(f"Invalid API key attempt: {get_key_prefix(api_key)}...")
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired API key",
        )

    logger.debug(f"Authenticated user: {key_data['user_name']}")
    return {
        "user_name": key_data["user_name"],
        "scopes": key_data["scopes"],
        "is_master_key": False,
        "api_key_id": key_data["id"],
    }


def require_scope(required_scope: str):
    """
    Dependency factory to require a specific scope.

    Usage:
        @router.post("/admin/keys", dependencies=[Depends(require_scope("admin"))])
    """
    async def scope_checker(
        auth: dict[str, Any] = Depends(verify_api_key),
    ) -> dict[str, Any]:
        scopes = auth.get("scopes", [])

        # "all" scope grants everything
        if "all" in scopes or required_scope in scopes:
            return auth

        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Required scope: {required_scope}",
        )

    return scope_checker


# Convenience dependencies
require_read = require_scope("read")
require_write = require_scope("write")
require_admin = require_scope("admin")
