# Multi-agent viewer design

## Problem

A single machine can run both OpenClaw and Hermes plugins side by side.
Each plugin instance:

- Has its **own** storage directory under `~/.<agent>/memos-plugin/`.
- Has its **own** SQLite database with disjoint session / episode /
  trace / skill namespaces.
- Wants to expose its memory viewer at a stable URL.

## Current design (2026-04 onwards)

### One agent, one port — period

Each agent runs its own viewer on its own well-known port:

| Agent     | Viewer URL                  |
| --------- | --------------------------- |
| openclaw  | `http://127.0.0.1:18799`    |
| hermes    | `http://127.0.0.1:18800`    |

The ports are **fixed** in the templates that ship with the installer
(`templates/config.openclaw.yaml`, `templates/config.hermes.yaml`)
and cannot be changed via `install.sh` (no `--port` flag). Users who
truly need a different port can edit `~/.<agent>/memos-plugin/config.yaml`
and restart that agent — but they take responsibility for the port
collision themselves.

### Why we deleted the previous "single port, hub/peer" design

An earlier revision of this plugin tried to put both agents behind a
single `:18799`:

- Whichever bridge bound the port first became "the hub" and reverse-
  proxied for the loser; the loser ran headless.
- A `HubPromoter` polled every 5 s so the loser could take over when
  the hub exited.
- A read-only `peer-core` opened the peer's SQLite (WAL) so
  `/openclaw/*` and `/hermes/*` both rendered live data from one
  process.

This worked, but it produced a steady stream of subtle bugs:

- **Mutation white-listing.** Every "looks like a write but doesn't
  touch SQLite" endpoint (`/api/v1/auth/*`, `/api/v1/config`,
  `/api/v1/models/test`) needed a hand-curated exemption from a 405
  guard. Forgetting one made the panel silently broken (Sign Out
  no-op, "测试" rejected, settings unsaved).
- **Wrong `home` everywhere.** Route handlers that read disk state
  (`loadConfig(home)`, e.g. for masked-secret resolution) ran with
  the *hub's* home unless we threaded the peer's home through
  `peerDeps`. Easy to miss; the failure mode was "settings page
  silently uses the wrong agent's apiKey".
- **Misleading status.** The peer panel had no live LLM / embedder
  client to query, so the sidebar status dot relied on disk-derived
  heuristics (config provider + most-recent trace ts). Fragile.
- **Restart-required UX.** Editing peer config wrote `config.yaml` on
  disk but the peer process only re-reads it on boot; users saw "I
  changed the model and nothing happened".

The complexity grew faster than the value. Two well-known ports is
boring, but boring is the goal.

### URL layout

```
http://127.0.0.1:18799/         → openclaw viewer SPA
http://127.0.0.1:18800/         → hermes viewer SPA
```

Both servers also accept the legacy prefixed forms (`/openclaw/...`,
`/hermes/...`) and respond with a 302 to the right port — so existing
bookmarks from the previous design keep working.

### No picker page

The root path on either viewer goes **straight to that agent's SPA**.
There is no "choose an agent" landing page — :18799 is openclaw,
:18800 is hermes, period. Each port is a self-contained app.

### Header switcher (the only cross-port surface)

The viewer SPA also probes the peer's well-known port once on load
(`web/src/stores/peers.ts`) and surfaces a small pill in the top bar
linking to it (when reachable). That's the only piece of cross-port
discovery in the whole system, and it's a single-shot `fetch` against
`http://127.0.0.1:<peer port>/api/v1/health`.

## Trade-off accepted

- **Two URLs to remember / bookmark.** That's the whole cost. We
  argue it's a one-time UX cost (users bookmark once) versus a
  recurring engineering tax that the hub/peer model imposed on every
  new feature.
- **No "view both panels in one tab".** There never really was — the
  peer panel was read-only and missed live SSE anyway. Now you open
  two browser tabs.
- **No login sharing across ports.** Browser cookies are scoped per
  `host:port`. If you enable password protection on both agents, you
  log in twice. Acceptable for a localhost-only viewer.
