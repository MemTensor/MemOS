"""
Admin Router for API Key Management.

Protected by master key or admin scope.
"""

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import memos.log
from memos.api.middleware.auth import require_scope, verify_api_key
from memos.api.utils.api_keys import (
    create_api_key_in_db,
    generate_master_key,
    list_api_keys,
    revoke_api_key,
)

logger = memos.log.get_logger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin"])


# Request/Response models
class CreateKeyRequest(BaseModel):
    user_name: str = Field(..., min_length=1, max_length=255)
    scopes: list[str] = Field(default=["read"])
    description: str | None = Field(default=None, max_length=500)
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


class CreateKeyResponse(BaseModel):
    message: str
    key: str  # Only returned once!
    key_prefix: str
    user_name: str
    scopes: list[str]


class KeyListResponse(BaseModel):
    message: str
    keys: list[dict[str, Any]]


class RevokeKeyRequest(BaseModel):
    key_id: str


class SimpleResponse(BaseModel):
    message: str
    success: bool = True


def _get_db_connection():
    """Get database connection for admin operations."""
    import psycopg2

    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "postgres"),
        port=int(os.getenv("POSTGRES_PORT", "5432")),
        user=os.getenv("POSTGRES_USER", "memos"),
        password=os.getenv("POSTGRES_PASSWORD", ""),
        dbname=os.getenv("POSTGRES_DB", "memos"),
    )


@router.post(
    "/keys",
    response_model=CreateKeyResponse,
    summary="Create a new API key",
    dependencies=[Depends(require_scope("admin"))],
)
def create_key(
    request: CreateKeyRequest,
    auth: dict = Depends(verify_api_key),
):
    """
    Create a new API key for a user.

    Requires admin scope or master key.

    **WARNING**: The API key is only returned once. Store it securely!
    """
    try:
        conn = _get_db_connection()
        try:
            api_key = create_api_key_in_db(
                conn=conn,
                user_name=request.user_name,
                scopes=request.scopes,
                description=request.description,
                expires_in_days=request.expires_in_days,
                created_by=auth.get("user_name", "unknown"),
            )

            logger.info(
                f"API key created for user '{request.user_name}' by '{auth.get('user_name')}'"
            )

            return CreateKeyResponse(
                message="API key created successfully. Store this key securely - it won't be shown again!",
                key=api_key.key,
                key_prefix=api_key.key_prefix,
                user_name=request.user_name,
                scopes=request.scopes,
            )
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Failed to create API key: {e}")
        raise HTTPException(status_code=500, detail="Failed to create API key")


@router.get(
    "/keys",
    response_model=KeyListResponse,
    summary="List API keys",
    dependencies=[Depends(require_scope("admin"))],
)
def list_keys(
    user_name: str | None = None,
    auth: dict = Depends(verify_api_key),
):
    """
    List all API keys (admin) or keys for a specific user.

    Note: Actual key values are never returned, only prefixes.
    """
    try:
        conn = _get_db_connection()
        try:
            keys = list_api_keys(conn, user_name=user_name)
            return KeyListResponse(
                message=f"Found {len(keys)} key(s)",
                keys=keys,
            )
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Failed to list API keys: {e}")
        raise HTTPException(status_code=500, detail="Failed to list API keys")


@router.delete(
    "/keys/{key_id}",
    response_model=SimpleResponse,
    summary="Revoke an API key",
    dependencies=[Depends(require_scope("admin"))],
)
def revoke_key(
    key_id: str,
    auth: dict = Depends(verify_api_key),
):
    """
    Revoke an API key by ID.

    The key will be deactivated but not deleted (for audit purposes).
    """
    try:
        conn = _get_db_connection()
        try:
            success = revoke_api_key(conn, key_id)
            if success:
                logger.info(f"API key {key_id} revoked by '{auth.get('user_name')}'")
                return SimpleResponse(message="API key revoked successfully")
            else:
                raise HTTPException(status_code=404, detail="API key not found or already revoked")
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to revoke API key: {e}")
        raise HTTPException(status_code=500, detail="Failed to revoke API key")


@router.post(
    "/generate-master-key",
    response_model=dict,
    summary="Generate a new master key",
    dependencies=[Depends(require_scope("admin"))],
)
def generate_new_master_key(
    auth: dict = Depends(verify_api_key),
):
    """
    Generate a new master key.

    **WARNING**: Store the key securely! Add MASTER_KEY_HASH to your .env file.
    """
    if not auth.get("is_master_key"):
        raise HTTPException(
            status_code=403,
            detail="Only master key can generate new master keys",
        )

    key, key_hash = generate_master_key()

    logger.warning("New master key generated - update MASTER_KEY_HASH in .env")

    return {
        "message": "Master key generated. Add MASTER_KEY_HASH to your .env file!",
        "key": key,
        "key_hash": key_hash,
        "env_line": f"MASTER_KEY_HASH={key_hash}",
    }


@router.get(
    "/health",
    summary="Admin health check",
)
def admin_health():
    """Health check for admin endpoints."""
    auth_enabled = os.getenv("AUTH_ENABLED", "false").lower() == "true"
    master_key_configured = bool(os.getenv("MASTER_KEY_HASH"))

    return {
        "status": "ok",
        "auth_enabled": auth_enabled,
        "master_key_configured": master_key_configured,
    }
