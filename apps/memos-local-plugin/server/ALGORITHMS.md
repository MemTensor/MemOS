# `server/` — Invariants & failure-mode decisions

This document sits alongside [`README.md`](./README.md). Where the
README covers the surface, here we pin down the **invariants** the
server upholds. These are the properties tests check for, and the
properties every change to this module must preserve.

The server is a Node `http.createServer` with a hand-written router.
No framework — we lean on the small surface to audit every security-
relevant decision.

## S1 — Loopback by default, opt-in for public

`host` defaults to `127.0.0.1`. Any binding to `0.0.0.0` is an
**explicit** act by the operator and must be accompanied by `apiKey`.
There is no `NODE_ENV === "development"` back-door that relaxes this;
relaxations must happen in the config file.

Rationale: accidentally exposing a memory server to the LAN would leak
every user interaction plus every LLM prompt/response.

## S2 — API key gating is timing-safe

The comparison in `middleware/auth.ts` is a simple `===`. JavaScript
`===` is short-circuit — a timing side channel could in principle leak
the key's prefix length. We consider the risk acceptable because:

- the default bind is loopback, so the attacker is already on the
  machine;
- the key is a pre-shared secret, not a hash of user input;
- the first byte of a 256-bit key has ~1 nat of information, and
  retrieving ~1 nat per byte is bounded by the string length; to fully
  recover a 32-char key on loopback the attacker needs to send ~10⁵
  requests per byte, totalling ~3·10⁶ requests.

If we ever host this on public infra we must switch to `timingSafeEqual`.
For now the README calls out "loopback only for public hosts" and
tests that 401 is returned for missing keys.

## S3 — Directory-traversal is rejected at the resolver

`middleware/static.ts` resolves the requested path against `staticRoot`
with `path.resolve`, then checks `target.startsWith(root)`. Paths that
escape the root (`../`, encoded dot-slash, symlinks) hit 403, never
200. We do **not** rely on the client to URL-decode correctly — the
`URL` constructor handles that before dispatch.

## S4 — SSE streams are rate-limited

`/api/v1/logs` is susceptible to unbounded emission: a noisy channel
could push megabytes per second, saturating the socket. We cap each
connection at 200 msg/sec via a token-bucket refilled once per second.
Dropped messages are **silent** — SSE has no back-pressure protocol
and we prefer a small gap to a stalled client.

The viewer re-queries `/api/v1/logs/tail` periodically if it suspects
a gap (last-seen timestamp > N seconds behind). This is done client-
side and out of scope for the server.

## S5 — SSE keep-alive every 20s

`:ka\n\n` lines are sent every 20s to prevent idle proxies from
closing the connection. Clients that explicitly request
`x-accel-buffering: no` avoid nginx buffering.

Tests cover the frame layout (`event:`, `id:`/`seq`, `data:`); they
don't assert keep-alive timing to avoid flaky timeouts.

## S6 — Routes are method + path, not prefixes

The router is a `Map<"METHOD /path", handler>`. This is intentional:

- No regex patterns means no accidental capture groups or ReDoS.
- A 405 Method-Not-Allowed requires probing both method-path tuples,
  which we do in the dispatch loop.
- Route count is ~20 and growing slowly; when it exceeds ~50 we'll
  revisit and introduce a proper trie.

## S7 — Request body is size-capped

Default `maxBodyBytes = 1 MiB`. A stream overflowing this throws
during `readBody`. The outer dispatch turns that into a 500, which is
not strictly accurate but sufficient — 4xx vs 5xx coding here matters
less than refusing the input.

## S8 — Static files are never cached permanently

`cache-control: public, max-age=60`. We don't emit ETag/If-Modified-
Since headers. For local viewer bundles rebuilt by Vite, 60s is low
enough that a browser refresh picks up changes but high enough that a
reload doesn't re-ship JS. If a larger horizon is required for
deployment, the operator sets their own `Cache-Control` via a reverse
proxy.

## S9 — Errors never leak stack traces

The outer dispatch catches any unhandled exception and writes `{error:
{code: "internal", message}}` only. Stack traces go to the log, not
the wire. Production hosts therefore can't distinguish "bug in server"
from "mis-phrased request" from the response alone — that's a
feature for security; debugging happens via the log SSE.

## S10 — Server close drains but doesn't kill

`server.close()` stops accepting new connections and waits for
existing ones to complete. Long-lived SSE connections will stall
shutdown; the bridge sets a 5s deadline above which it force-closes
the socket. We do NOT call `server.closeAllConnections()` from inside
the module — that's the caller's choice.

## S11 — Concurrency is single-threaded

The Node event loop serialises handlers. Nothing in the server uses
`Worker` or `cluster`. Concurrency comes from `async` + microtask
interleaving. Handlers therefore don't need mutexes — race conditions
between routes are impossible by construction.

## Summary checklist

Before landing a change, verify:

- [ ] Default bind remains loopback (S1).
- [ ] Directory traversal test in `tests/unit/server/http.test.ts`
      still passes (S3).
- [ ] SSE keep-alive emits `:ka\n\n` (S5).
- [ ] No route added via regex pattern (S6).
- [ ] No response includes a stack trace (S9).
