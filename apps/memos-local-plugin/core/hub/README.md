# `core/hub/`

> Optional **team sharing** layer. Disabled by default; a user opts in
> via `hub.enabled: true` in `config.yaml`.

## Scope

- **Client role**: push locally-crystallised skills + optional L1 trace
  excerpts to a shared hub; pull peers' skills into local storage.
- **Server role**: host a tiny auth'd API that other MemOS instances on
  the same LAN / VPN connect to.

We deliberately keep the hub **out of the algorithm critical path**:

- Every hub call is behind `config.hub.enabled`; the orchestrator never
  blocks on a failing hub.
- Outbound pushes go via `hub.client` with bounded retries; failures
  degrade to local-only.
- Inbound hub content **never** mutates local L2/L3/Skill directly — it
  lands in a dedicated `hub.imported_skills` table (see migration) and
  is lifted into the retrieval pool at query time only.

## Files

| File           | Responsibility                                                  |
| -------------- | --------------------------------------------------------------- |
| `auth.ts`      | `teamToken` / `userToken` helpers; constant-time comparison.    |
| `server.ts`    | HTTP server (stdlib only) for hub role.                         |
| `user-manager.ts` | In-memory user/group allow-lists, persisted to SQLite.       |

## Invariants

- Hub never sees raw trace text of a user who didn't opt in.
- Users can revoke a published skill; the hub replicates the tombstone
  to all subscribers on their next poll.
- Audit: every push / pull / publish / unpublish emits an entry in
  `audit.log` (never rotated — only gzipped monthly).

## Tests

Hub code is behind a feature flag, so tests live at
`tests/unit/hub/` (if present) and run only when `hub.enabled=true` in
the test config. The default CI suite exercises the disabled path
(ensuring the orchestrator doesn't break when the hub is off).
