# Multi-agent viewer design

## Problem

A single machine can run both OpenClaw and Hermes plugins side by side.
Each plugin instance:

- Has its **own** storage directory under `~/.<agent>/memos-plugin/`.
- Has its **own** SQLite database with disjoint session / episode /
  trace / skill namespaces.
- Starts its own HTTP viewer.

The default viewer port `18799` is therefore claimed twice. Two
options were considered:

1. **Single viewer, shared DB** — route every plugin's writes through
   one process that owns the port and one merged SQLite file. This
   breaks V7 §0.3's per-agent isolation guarantee (reward signals
   from agent A must not influence agent B's skill weights) and
   requires invasive bridge work.
2. **One viewer per agent, with cross-linking** — keep each instance
   sovereign, but surface the "other" agent in the header so users
   can jump between viewers without hunting for a port.

We chose **option 2**. The implementation lives in three files.

## Implementation

### 1. Automatic port fallback

`server/http.ts::startHttpServer` now walks the configured port and
the next 10 ports until it finds a free one:

```
for (let i = 0; i <= 10; i++) {
  const candidate = port + i;
  try {
    await server.listen(candidate, host);
    break;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    // try next port
  }
}
```

The actually-bound port is logged and reflected back via `/api/v1/health`.

### 2. Agent identity on `/api/v1/health`

Each core knows its own agent (`handle.agent`). The health endpoint
returns:

```json
{
  "ok": true,
  "agent": "openclaw",
  "version": "2.0.0-beta.1",
  "paths": { … }
}
```

### 3. Peer discovery in the viewer

`web/src/stores/peers.ts` probes the ±10 ports around the current
tab's port, calling each candidate's `/api/v1/health`. Any response
whose `agent` differs from this tab's becomes a **peer** listed in
the header:

```
[MemOS logo]  MemOS Local   reflect2evolve   [openclaw] [↗ hermes]
```

The peer pill is a plain `<a href>` that opens the other viewer in
a new tab. No cross-origin cookies, no shared auth — each viewer
keeps its own session.

## Non-goals

- We don't aggregate memories from both agents into one search.
  Different agents' memory namespaces are deliberately isolated.
- We don't relay writes from one agent's process through another.
  Every agent continues to persist to its own `memos.db`.

## Installing both agents today

```bash
bash install.sh --version path-to.tgz   # interactive: pick "both"
```

With the auto-fallback in place:

- First plugin to boot grabs `:18799`.
- Second plugin logs `server.port_fallback { requested: 18799, bound: 18800 }`
  and the header of **either** viewer shows a pill linking to the
  other one.

## Future: Hub mode

If a user wants a **single URL** for both agents (e.g. for nginx),
the cleanest path is to add a `viewer.peersFromConfig: [{...}]`
array to `config.yaml`, point agent B at agent A's URL, and disable
agent B's own HTTP listener. That becomes a superset of today's
peer-discovery UI and is slotted for a later phase.
