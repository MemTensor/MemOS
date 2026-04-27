"""
Agent authentication middleware for MemOS.

Validates per-agent API keys loaded from a JSON config file.
On a valid key, stores the authenticated user_id in a contextvar so
handlers can verify the caller isn't spoofing a different user_id.

Config file format (MEMOS_AGENT_AUTH_CONFIG env var):
{
  "version": 2,
  "agents": [
    {"key_hash": "$2b$12$...", "key_prefix": "ak_244c", "user_id": "ceo", "description": "CEO Agent"},
    ...
  ]
}

Legacy format (version 1, auto-detected):
{
  "version": 1,
  "agents": [
    {"key": "ak_...", "user_id": "ceo", "description": "CEO Agent"},
    ...
  ]
}

Usage:
  Header: Authorization: Bearer ak_<32-hex-chars>

Env vars:
  MEMOS_AGENT_AUTH_CONFIG  — path to agents-auth.json (required to enable auth)
  MEMOS_AUTH_REQUIRED      — if "true", requests without a valid key are rejected (401)
                             if "false" (default), unauthenticated requests pass through
                             but cannot spoof an authenticated user
"""

import hashlib
import json
import os
import time
from collections import OrderedDict, defaultdict
from contextvars import ContextVar

import bcrypt
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from memos.log import get_logger

logger = get_logger(__name__)

# Thread-safe contextvar: holds the user_id the key authenticated as, or None
_authenticated_user: ContextVar[str | None] = ContextVar("authenticated_user", default=None)

# Length of the raw-key prefix used for bucket-lookup. Must match the prefix
# length the provisioning script writes into agents-auth.json (12 chars).
# See: deploy/scripts/setup-memos-agents.py in the Hermes repo.
KEY_PREFIX_LEN = 12


def get_authenticated_user() -> str | None:
    """Return the user_id bound to the current request's API key, or None if unauthenticated."""
    return _authenticated_user.get()


class AgentAuthMiddleware(BaseHTTPMiddleware):
    """
    Starlette middleware that validates per-agent API keys.

    - Reads key registry from MEMOS_AGENT_AUTH_CONFIG on startup.
    - Only applies to /product/* endpoints (skips /health, /download, etc).
    - Stores authenticated user_id in a contextvar for handler-level spoof checks.
    - Rate-limits failed auth attempts per IP (10 failures / 60s → 429 for 60s).
    - Auto-reloads config when the file changes on disk.
    """

    # Paths that skip agent auth entirely (admin router has its own auth)
    SKIP_PATHS = {"/health", "/docs", "/openapi.json", "/redoc"}
    SKIP_PREFIXES = ("/download", "/admin")

    # Rate limiting constants
    RATE_LIMIT_MAX_FAILURES = 10
    RATE_LIMIT_WINDOW_SECONDS = 60

    # Verified-key cache (skip bcrypt on repeat keys). Bounded FIFO; small because
    # we only have a handful of agents. Values are user_ids, never bcrypt hashes.
    VERIFY_CACHE_MAX = 64

    def __init__(self, app, config_path: str | None = None):
        super().__init__(app)
        self.config_path = config_path or os.getenv("MEMOS_AGENT_AUTH_CONFIG", "")
        self._agents: list[dict] = []  # [{"key_hash": bytes, "user_id": str}, ...] for v2
        self._keys: dict[str, str] = {}  # raw_key → user_id (v1 legacy fallback)
        # Bucket index: key_prefix → [agent records sharing that prefix].
        # On each request we BCrypt-verify only the bucket for the incoming key's
        # prefix (typically 1 candidate, occasionally 2-3 on a collision) instead
        # of every agent's hash. This caps worst-case BCrypt cost so a flood of
        # random invalid keys can no longer DoS the server.
        self._prefix_index: dict[str, list[dict]] = {}
        # Records that lack a key_prefix (legacy entries, pre-schema-2). We fall
        # back to walking these on every lookup so they still authenticate, but
        # they degrade the worst case toward the old O(N) behaviour. A single
        # WARN at load tells ops to backfill via setup-memos-agents.py.
        self._unprefixed_agents: list[dict] = []
        self._is_hashed = False
        self.auth_required = os.getenv("MEMOS_AUTH_REQUIRED", "false").lower() == "true"
        self._config_mtime: float = 0.0
        self._fail_tracker: dict[str, list[float]] = defaultdict(list)
        # sha256(raw_key) -> user_id. Only populated on successful bcrypt verify.
        self._verify_cache: OrderedDict[str, str] = OrderedDict()
        self._load_config()

    def _load_config(self) -> None:
        """Load key registry from JSON file. Supports both hashed (v2) and plaintext (v1) formats."""
        if not self.config_path or not os.path.exists(self.config_path):
            logger.warning(
                f"[AgentAuth] Config not found at '{self.config_path}'. "
                "Auth disabled — set MEMOS_AGENT_AUTH_CONFIG to enable."
            )
            return

        try:
            self._config_mtime = os.path.getmtime(self.config_path)
            with open(self.config_path) as f:
                data = json.load(f)

            agents = data.get("agents", [])
            version = data.get("version", 1)

            if version >= 2 or any("key_hash" in a for a in agents):
                # Hashed format (v2)
                self._agents = []
                self._keys = {}
                self._prefix_index = {}
                self._unprefixed_agents = []
                self._is_hashed = True
                unprefixed_uids: list[str] = []
                for entry in agents:
                    if not entry.get("key_hash"):
                        continue
                    record = {
                        "key_hash": entry["key_hash"].encode("utf-8"),
                        "user_id": entry["user_id"],
                    }
                    self._agents.append(record)
                    prefix = entry.get("key_prefix")
                    if prefix and len(prefix) >= KEY_PREFIX_LEN:
                        # Normalise on the canonical prefix length so the lookup
                        # key matches whatever we extract from the incoming raw key.
                        bucket_key = prefix[:KEY_PREFIX_LEN]
                        self._prefix_index.setdefault(bucket_key, []).append(record)
                    else:
                        self._unprefixed_agents.append(record)
                        unprefixed_uids.append(entry["user_id"])
                logger.info(
                    f"[AgentAuth] Loaded {len(self._agents)} hashed agent key(s) from "
                    f"{self.config_path} ({len(self._prefix_index)} prefix bucket(s), "
                    f"{len(self._unprefixed_agents)} legacy unprefixed)"
                )
                if unprefixed_uids:
                    # Single startup WARN — not per-request — telling ops how to
                    # eliminate the O(N) degrade. See agent_auth.py module docstring
                    # in the Hermes provisioning script for the migration story.
                    logger.warning(
                        "[AgentAuth] %d agent record(s) lack key_prefix and will "
                        "force an O(N) BCrypt walk on every lookup: %s. "
                        "Run setup-memos-agents.py against agents-auth.json to "
                        "backfill prefixes (only possible for entries with a "
                        "recoverable raw key). For pure-hash entries, rotate the "
                        "key: delete the entry from agents-auth.json and re-run "
                        "the provisioning script.",
                        len(unprefixed_uids),
                        unprefixed_uids,
                    )
            else:
                # Legacy plaintext format (v1)
                self._agents = []
                self._is_hashed = False
                self._keys = {entry["key"]: entry["user_id"] for entry in agents if entry.get("key")}
                logger.info(
                    f"[AgentAuth] Loaded {len(self._keys)} plaintext agent key(s) from {self.config_path} "
                    "(legacy v1 format — run setup-memos-agents.py to migrate to hashed keys)"
                )
        except Exception as e:
            logger.error(f"[AgentAuth] Failed to load config: {e}")

    def _check_reload(self) -> None:
        """Reload config if the file has been modified since last load."""
        if not self.config_path or not os.path.exists(self.config_path):
            return
        try:
            mtime = os.path.getmtime(self.config_path)
            if mtime != self._config_mtime:
                logger.info("[AgentAuth] Config file changed on disk — reloading.")
                self._agents = []
                self._keys = {}
                self._prefix_index = {}
                self._unprefixed_agents = []
                self._verify_cache.clear()
                self._load_config()
        except OSError:
            pass

    def reload(self) -> None:
        """Hot-reload key registry without restarting the server."""
        self._agents = []
        self._keys.clear()
        self._prefix_index = {}
        self._unprefixed_agents = []
        self._verify_cache.clear()
        self._load_config()

    def _should_skip(self, path: str) -> bool:
        if path in self.SKIP_PATHS:
            return True
        return any(path.startswith(p) for p in self.SKIP_PREFIXES)

    def _is_rate_limited(self, client_ip: str) -> bool:
        """Check if a client IP has exceeded the auth failure rate limit."""
        now = time.monotonic()
        window_start = now - self.RATE_LIMIT_WINDOW_SECONDS
        # Prune old entries
        failures = self._fail_tracker[client_ip]
        self._fail_tracker[client_ip] = [t for t in failures if t > window_start]
        return len(self._fail_tracker[client_ip]) >= self.RATE_LIMIT_MAX_FAILURES

    def _record_failure(self, client_ip: str) -> None:
        """Record an auth failure for rate limiting."""
        self._fail_tracker[client_ip].append(time.monotonic())

    def _clear_failures(self, client_ip: str) -> None:
        """Clear failure history on successful auth."""
        self._fail_tracker.pop(client_ip, None)

    def _authenticate_key(self, key: str) -> str | None:
        """Validate an API key. Returns user_id on success, None on failure.

        Hashed (v2) path is layered:

        1. **Verify cache** (sha256(raw_key) → user_id): repeat valid keys skip
           BCrypt entirely. Failures are never cached — that would let an
           attacker probe the cache to enumerate valid keys.
        2. **Prefix bucket lookup**: BCrypt-check only the candidates whose
           stored ``key_prefix`` matches the incoming key's first KEY_PREFIX_LEN
           chars. With the provisioning script's 12-char prefix, collision
           probability across N agents is ≪ N, so worst case is 1-2 BCrypts
           on a valid lookup, **0** on a random bad key (no bucket match) —
           down from O(N) ~250ms-per-agent on every invalid request.
        3. **Unprefixed fallback**: any record loaded without ``key_prefix``
           (legacy entries pre-schema-2) is also walked. We need this so
           legacy hashes still authenticate; the load-time WARN tells ops
           how to eliminate the cost.
        """
        if self._is_hashed:
            key_bytes = key.encode("utf-8")
            cache_key = hashlib.sha256(key_bytes).hexdigest()
            cached = self._verify_cache.get(cache_key)
            if cached is not None:
                # Refresh recency
                self._verify_cache.move_to_end(cache_key)
                return cached

            # Bucket lookup. An incoming key shorter than the prefix length
            # cannot match any well-formed bucket — skip straight to the
            # legacy fallback so we still authenticate any pre-schema-2 hash.
            if len(key) >= KEY_PREFIX_LEN:
                candidates = self._prefix_index.get(key[:KEY_PREFIX_LEN], ())
            else:
                candidates = ()

            for agent in candidates:
                if bcrypt.checkpw(key_bytes, agent["key_hash"]):
                    self._verify_cache[cache_key] = agent["user_id"]
                    self._verify_cache.move_to_end(cache_key)
                    if len(self._verify_cache) > self.VERIFY_CACHE_MAX:
                        self._verify_cache.popitem(last=False)
                    return agent["user_id"]

            # Legacy fallback: only walked if at least one record lacks a prefix.
            for agent in self._unprefixed_agents:
                if bcrypt.checkpw(key_bytes, agent["key_hash"]):
                    self._verify_cache[cache_key] = agent["user_id"]
                    self._verify_cache.move_to_end(cache_key)
                    if len(self._verify_cache) > self.VERIFY_CACHE_MAX:
                        self._verify_cache.popitem(last=False)
                    return agent["user_id"]
            return None
        else:
            return self._keys.get(key)

    async def dispatch(self, request: Request, call_next):
        if self._should_skip(request.url.path):
            return await call_next(request)

        # Auto-reload config if file changed
        self._check_reload()

        client_ip = request.client.host if request.client else "unknown"
        rate_limited = self._is_rate_limited(client_ip)

        auth_header = request.headers.get("Authorization", "").strip()

        # No auth header
        if not auth_header:
            if self.auth_required:
                return JSONResponse(
                    {"detail": "Authorization header required. Use: Authorization: Bearer <agent-key>"},
                    status_code=401,
                )
            # Unauthenticated passthrough — handlers will still enforce cube permissions
            token = _authenticated_user.set(None)
            try:
                return await call_next(request)
            finally:
                _authenticated_user.reset(token)

        # Parse Bearer token
        parts = auth_header.split(None, 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            self._record_failure(client_ip)
            if rate_limited:
                return JSONResponse(
                    {"detail": "Too many failed authentication attempts. Try again later."},
                    status_code=429,
                )
            return JSONResponse(
                {"detail": "Invalid Authorization format. Expected: Bearer <agent-key>"},
                status_code=401,
            )

        key = parts[1].strip()
        user_id = self._authenticate_key(key)

        if user_id is None:
            self._record_failure(client_ip)
            if rate_limited:
                return JSONResponse(
                    {"detail": "Too many failed authentication attempts. Try again later."},
                    status_code=429,
                )
            return JSONResponse(
                {"detail": "Invalid or unknown agent key."},
                status_code=401,
            )

        # Successful auth — clear failure history
        self._clear_failures(client_ip)

        logger.debug(f"[AgentAuth] Authenticated: user_id={user_id}")
        token = _authenticated_user.set(user_id)
        try:
            return await call_next(request)
        finally:
            _authenticated_user.reset(token)
