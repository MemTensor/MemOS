# MemOS Overlays

Overlays are deployment-specific customizations that extend the base MemOS without modifying core files.

## Structure

```
overlays/
└── krolik/                 # Deployment name
    └── api/
        ├── middleware/
        │   ├── __init__.py
        │   ├── auth.py         # API Key authentication
        │   └── rate_limit.py   # Redis rate limiting
        ├── routers/
        │   ├── __init__.py
        │   └── admin_router.py # API key management
        ├── utils/
        │   ├── __init__.py
        │   └── api_keys.py     # Key generation utilities
        └── server_api_ext.py   # Extended entry point
```

## How It Works

1. **Base MemOS** provides core functionality (memory operations, embeddings, etc.)
2. **Overlays** add deployment-specific features without modifying base files
3. **Dockerfile** merges overlays on top of base during build

## Dockerfile Usage

```dockerfile
# Clone base MemOS
RUN git clone --depth 1 https://github.com/anatolykoptev/MemOS.git /app

# Install base dependencies
RUN pip install -r /app/requirements.txt

# Apply overlay (copies files into src/memos/)
RUN cp -r /app/overlays/krolik/* /app/src/memos/

# Use extended entry point
CMD ["gunicorn", "memos.api.server_api_ext:app", ...]
```

## Syncing with Upstream

```bash
# 1. Fetch upstream changes
git fetch upstream

# 2. Merge upstream into main (preserves overlays)
git merge upstream/main

# 3. Resolve conflicts if any (usually none in overlays/)
git status

# 4. Push to fork
git push origin main
```

## Adding New Overlays

1. Create directory: `overlays/<deployment-name>/`
2. Add customizations following the same structure
3. Create `server_api_ext.py` as entry point
4. Update Dockerfile to use the new overlay

## Security Features (krolik overlay)

### API Key Authentication
- SHA-256 hashed keys stored in PostgreSQL
- Master key for admin operations
- Scoped permissions (read, write, admin)
- Internal service bypass for container-to-container

### Rate Limiting
- Redis-based sliding window algorithm
- In-memory fallback for development
- Per-key or per-IP limiting
- Configurable via environment variables

### Admin API
- `/admin/keys` - Create, list, revoke API keys
- `/admin/health` - Auth system status
- Protected by admin scope or master key
