# Security & Tuning Patches

This fork maintains a set of patches on top of upstream `MemTensor/MemOS` for
production deployment inside the Hermes multi-agent system.

## Why a fork

Upstream is a reference implementation. We need:
- Per-agent API key auth with spoof detection and cube-level ACL
- Hardened defaults (localhost binding, required passwords, secret encryption)
- Search recall tuning (was returning 1/12 relevant results on vague queries)
- Memory extraction quality fixes (English enforcement, granularity rule)

See the full audit history at
`memos-setup/learnings/` in the [hermes-multi-agent](https://github.com/sergiocoding96/hermes-multi-agent)
repo.

## Patched Files

| File | Category | What changed |
|------|----------|-------------|
| `src/memos/api/middleware/agent_auth.py` | **NEW** | Per-agent Bearer-key auth middleware, bcrypt v2 format, auth-failure rate limit, auto-reload on config mtime change |
| `src/memos/api/middleware/request_context.py` | Security | Strip `Authorization` + `Cookie` headers from logs |
| `src/memos/api/server_api.py` | Security | Register `RateLimitMiddleware` + `AgentAuthMiddleware` + admin router; bind to `MEMOS_BIND_HOST` (default 127.0.0.1) |
| `src/memos/api/routers/server_router.py` | Authorization | `_enforce_cube_access()` helper; auth on 11 previously-unprotected endpoints; scheduler caps (300s max timeout, cross-agent checks) |
| `src/memos/api/routers/admin_router.py` | Admin API | Full rewrite for bcrypt v2 key management via `agents-auth.json`; list/create/revoke/rotate |
| `src/memos/api/handlers/search_handler.py` | Security + tuning | Spoof check + cube isolation; env-configurable search params (`MOS_SEARCH_TOP_K_FACTOR`, `MOS_MMR_TEXT_THRESHOLD`, `MOS_MMR_PENALTY_THRESHOLD`) |
| `src/memos/api/handlers/add_handler.py` | Security | Spoof check + cube isolation; empty content rejection; log request summary instead of full body |
| `src/memos/api/handlers/component_init.py` | Security | Inject `UserManager` into `HandlerDependencies` for ACL checks |
| `src/memos/api/product_models.py` | Tuning | Relativity default 0.20 → 0.05 (was filtering vague but valid queries) |
| `src/memos/mem_user/user_manager.py` | Authorization | `validate_user_cube_access` resolves cubes by `cube_id` → `cube_name` → `owner_id` (agents address cubes by `user_id`, not `cube_id`) |
| `src/memos/vec_dbs/qdrant.py` | Bug fix | Pass `api_key` with host+port mode (upstream only supported url mode); force `https=False` for localhost |
| `src/memos/templates/mem_reader_prompts.py` | Quality | Granularity rule (split by idea, not sentence); English output enforcement (prevents Chinese leakage on English input) |
| `src/memos/multi_mem_cube/single_cube.py` | Quality | Write-time dedup via cosine similarity ≥ 0.90 |

## Rebasing on Upstream

When pulling new upstream changes:

```bash
git fetch upstream
git merge upstream/main
# Or: git rebase upstream/main
# Resolve conflicts in the patched files above, prefer keeping our logic
```

## Environment Variables

Security-sensitive vars this fork requires:

| Var | Purpose |
|-----|---------|
| `MEMOS_AUTH_REQUIRED` | Set to `true` in production (otherwise the auth middleware is a no-op) |
| `MEMOS_AGENT_AUTH_CONFIG` | Path to `agents-auth.json` (bcrypt v2 format) |
| `MEMOS_ADMIN_KEY` | Separate key for `/admin/*` routes — NOT an agent key |
| `MEMOS_BIND_HOST` | Default 127.0.0.1. Set `0.0.0.0` only when behind a reverse proxy |
| `QDRANT_API_KEY` | Required — Qdrant has no default auth |
| `NEO4J_PASSWORD` | Required — no default fallback accepted |
| `MEMRADER_API_KEY` | DeepSeek V3 key for memory extraction (MiniMax's `<think>` tags break extraction) |

Tuning vars (optional):

| Var | Default | Purpose |
|-----|---------|---------|
| `MOS_SEARCH_TOP_K_FACTOR` | 5 | Expansion factor before MMR dedup (was 3x hardcoded) |
| `MOS_MMR_TEXT_THRESHOLD` | 0.85 | Text similarity threshold for dedup (was 0.92 — too strict) |
| `MOS_MMR_PENALTY_THRESHOLD` | 0.70 | MMR exponential penalty start (was 0.90) |

## Secrets Management

Secrets are encrypted with `age` at `~/.memos/secrets.env.age` and decrypted
at boot by `start-memos.sh`. See that script for details.

Contains:
- `MINIMAX_API_KEY` (primary LLM)
- `MEMRADER_API_KEY` (DeepSeek, for memory extraction)
- `NEO4J_PASSWORD`
- `QDRANT_API_KEY`
- `MEMOS_ADMIN_KEY`
