/**
 * HTTP server types — public surface.
 *
 * The server wraps a `MemoryCore` plus a static site directory and serves:
 *
 *   1. a JSON REST API under /api/v1,
 *   2. a live event stream at /api/v1/events (SSE),
 *   3. a live log stream at /api/v1/logs (SSE),
 *   4. static assets for the viewer + product site.
 *
 * The server is purely a façade — it never talks to the database or
 * any other subsystem directly. All business logic lives in the core;
 * this layer only handles URL routing, serialisation, and transport.
 */

import type { BridgeHealth, MemoryCore } from "../agent-contract/memory-core.js";
import type { LogRecord } from "../agent-contract/log-record.js";

export interface ServerOptions {
  /** Network port to listen on. Defaults to 0 (random free port). */
  port?: number;
  /** Hostname/interface to bind. Defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /** Root directory whose contents are served as static assets. */
  staticRoot?: string;
  /**
   * Optional site directory (separate from the viewer). If provided,
   * served at `/site/*`. If absent, `/site/*` returns 404.
   */
  siteRoot?: string;
  /** Optional shared secret required on every /api/* request via `x-api-key`. */
  apiKey?: string;
  /** Extra headers merged into every response (CORS, security, etc.). */
  extraHeaders?: Record<string, string>;
  /** Maximum request body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
  /** Buffer size for the SSE log tail on first connection. Default 200. */
  logTailSize?: number;
  /**
   * Which agent this viewer is attached to. Each agent runs on its
   * own well-known port (openclaw=:18799, hermes=:18800); the field
   * surfaces in `/api/v1/health` and drives the optional root-path
   * picker that links to the *other* agent's port when both are
   * installed on disk.
   */
  agent?: "openclaw" | "hermes";
}

export interface ServerHandle {
  /** The listening URL. */
  url: string;
  /** Actual bound port (useful when `options.port === 0`). */
  port: number;
  /** Stop accepting new requests and drain existing ones. */
  close(): Promise<void>;
  /** True once `close` has resolved. */
  readonly closed: boolean;
}

export interface ServerDeps {
  /** The core that answers every API call. */
  core: MemoryCore;
  /**
   * The memos home (agent-specific, e.g. `~/.openclaw/memos-plugin`).
   * Required so features like the password gate can sidecar a
   * `.auth.json` file next to `config.yaml` without re-resolving
   * paths. Structural type so test fixtures don't need to import
   * `ResolvedHome`.
   */
  /**
   * The memos home bundle. Carries the full `ResolvedHome` shape so
   * routes can call `loadConfig(home)` directly (e.g. the
   * `/models/test` endpoint needs unmasked secrets). We type it
   * loosely (`root: string`) to stay compatible with tiny test
   * fixtures that only need `home.root`.
   */
  home?: {
    root: string;
    configFile?: string;
    dataDir?: string;
    dbFile?: string;
    skillsDir?: string;
    logsDir?: string;
  };
  /**
   * Preview tail of the most recent logs for initial SSE hydration.
   * If absent, `/api/v1/logs` starts empty.
   */
  logTail?: () => LogRecord[];
  /**
   * Optional host-transport health surfaced on `/api/v1/health`.
   * Hermes uses this for the Python provider ↔ Node bridge connection.
   */
  bridgeStatus?: () => BridgeHealth;
}
