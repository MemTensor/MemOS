# Bridge Shutdown Path Audit

**Date:** 2026-05-24  
**Branch:** companion-stable  
**Purpose:** Verify the 20s `withShutdownTimeout` patch covers every path where
`core.shutdown()` is called and a hang could orphan the bridge process.

---

## Shutdown call sites

### 1. Daemon SIGTERM / SIGINT — `bridge.cts:373–381`

```ts
const shutdownDaemon = async (sig: string) => {
  removeOwnedPidFile();
  try { await viewer!.close(); } catch { /* best-effort */ }
  await withShutdownTimeout(core.shutdown());   // ✅ COVERED
  process.exit(0);
};
process.on("SIGINT",  () => void shutdownDaemon("SIGINT"));
process.on("SIGTERM", () => void shutdownDaemon("SIGTERM"));
```

**Verdict:** covered by the existing patch (commit `56ebe7a3`).

---

### 2. Non-daemon SIGTERM / SIGINT — `bridge.cts:479–494`

```ts
const shutdown = async (sig: string) => {
  removeOwnedPidFile();
  if (viewer) { try { await viewer.close(); } catch {} }
  await withShutdownTimeout(waitForShutdown(core, activeStdio));  // ✅ COVERED
  process.exit(0);
};
```

`waitForShutdown` calls `core.shutdown()` internally; the race wraps the whole chain.  
**Verdict:** covered.

---

### 3. Headless stdin-EOF exit — `bridge.cts:517–520`

```ts
removeOwnedPidFile();
await withShutdownTimeout(core.shutdown());   // ✅ COVERED
process.exit(0);
```

**Verdict:** covered.

---

### 4. Viewer-running keepalive path — `bridge.cts:500–515` ⚠️ PREVIOUSLY UNCOVERED

Reached when stdin closes but the HTTP viewer is still serving.
Before this patch:

```ts
void core.shutdown().then(() => process.exit(0));  // ❌ no timeout
```

The `setInterval` keepalive is `.unref()`'d, but `core.shutdown()` creates active
LLM-request HTTP connections that ARE ref'd — so the process stays alive until
shutdown completes. If `flush()` hangs on an L2/L3 LLM call this path orphaned
the bridge permanently.

**Fix** (this PR): wrap with `withShutdownTimeout`.

```ts
void withShutdownTimeout(core.shutdown()).then(() => process.exit(0));  // ✅ FIXED
```

---

### 5. Daemon EADDRINUSE / viewer-error exit — `bridge.cts:358–370` ⚠️ PREVIOUSLY UNCOVERED

Two sequential error paths when the daemon can't bind the viewer port:

```ts
// Path A: port still busy after 10 retry attempts
await core.shutdown();   // ❌ no timeout
process.exit(1);

// Path B: non-EADDRINUSE error starting viewer
await core.shutdown();   // ❌ no timeout
process.exit(1);
```

If `core.shutdown()` blocks here (L2/L3 mid-flight, network hang), the daemon
stays alive indefinitely with no viewer and no JSON-RPC pipe — invisible but
burning CPU.

**Fix** (this PR): both calls wrapped with `withShutdownTimeout`.

---

## `core.shutdown()` internal chain

```
core.shutdown()  [memory-core.ts:1442]
  hubRuntime?.stop()              — clears timers, closes http.Server (fast)
  handle.shutdown()  [orchestrator.ts:1357]
    flush()
      capture.drain()             — SQLite writes (sync, fast)
      reward.drain()              — LLM scoring call (async, ~2-10s)
      l2.drain()                  — L2 induction LLM call (async, ~5s)
      l3.drain()                  — L3 abstraction LLM call (async)
      skills.flush()              — skill crystallization LLM call (async)
      feedback.flush()            — async
      embeddingRetryWorker.flush()— ONNX inference (async JS, event loop stays live)
    detach subscribers
    sessionManager.shutdown()
  telemetry.shutdown()
  db.close()                      — better-sqlite3 close (sync, fast)
```

**Key invariant:** every potentially slow operation in `flush()` is async and
yields the event loop. The `setTimeout` inside `withShutdownTimeout` can always
fire because Node's event loop is not blocked by any of these calls. Once the
race resolves (either flush completes or timeout fires), `process.exit()` runs
immediately and terminates the process regardless of any in-flight HTTP or ONNX
work.

---

## Blocking call analysis

| Call | Sync/async | Can block event loop? | Covered by timeout? |
|---|---|---|---|
| `better-sqlite3` writes | Sync C++ | Yes, briefly (<1ms per stmt) | N/A — too fast |
| `better-sqlite3` WAL checkpoint | Sync C++ | Yes, briefly | N/A — auto, fast |
| LLM HTTP calls (L2/L3/reward/skill) | Async | No | ✅ via Promise.race |
| ONNX embedding (`@hf/transformers`) | Async WASM | No | ✅ via Promise.race |
| ONNX model download (first-time) | Async fetch | No | ✅ via Promise.race |
| `hubRuntime.stop()` → `http.Server.close()` | Async | No | ✅ wrapped by outer race |

**Conclusion:** no synchronous call in the shutdown chain is long enough to
prevent the `setTimeout` from firing. The 20s timeout is effective across all
paths after this patch.

---

## Remaining considerations (not bugs — lower priority)

### Daemon respawn loop

`killExistingBridge()` reads the PID file, sends SIGTERM, waits up to 5s, then
SIGKILL. If the new bridge crashes before writing its PID file, the next bridge
still starts cleanly (stale PID in file → `process.kill(pid, 0)` throws →
`readPidFile` returns null → no double-kill). No orphan accumulation path found.

### Python `ensure_viewer_daemon()` kill

When the Python health probe kills a bridge that didn't bind port 18800 within
15s, `killExistingBridge()` in the replacement bridge handles teardown. The
replacement bridge sends SIGTERM to the old one, waits 5s, then SIGKILL. The
old bridge's SIGTERM handler calls `shutdownDaemon` which is covered by
`withShutdownTimeout`. If the 5s wait expires before the SIGTERM handler
finishes, Python SIGKILL's the old bridge — force-kill is always safe.

### Two-bridge SQLite lock race

`PRAGMA busy_timeout = 5000` is set at DB open. If two bridges compete for a
write lock, the loser waits up to 5s then receives `SQLITE_BUSY`. This surfaces
as a caught error in the repo layer, not a hang.

---

## Summary

| Site | Before patch | After patch |
|---|---|---|
| Daemon SIGTERM | ✅ covered | ✅ covered |
| Non-daemon SIGTERM | ✅ covered | ✅ covered |
| Headless stdin-EOF | ✅ covered | ✅ covered |
| Viewer-running keepalive | ❌ no timeout | ✅ FIXED |
| EADDRINUSE/viewer-error exit (×2) | ❌ no timeout | ✅ FIXED |
