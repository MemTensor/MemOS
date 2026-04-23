/**
 * Multi-agent peer discovery.
 *
 * Each `memos-local-plugin` instance owns ONE agent (openclaw /
 * hermes). When both agents are installed on the same machine they
 * get their own SQLite DBs and their own viewer processes. The
 * default viewer port is 18799 for both, so the second one to start
 * auto-falls-back to the next free port (see
 * `server/http.ts::startHttpServer`).
 *
 * To help the user jump between viewers without guessing ports we
 * probe a small window of nearby ports on first mount and cache any
 * peer we find. The result powers the agent switcher in the header.
 */
import { signal } from "@preact/signals";
import { health as selfHealth } from "./health";

export interface PeerViewer {
  agent: "openclaw" | "hermes";
  url: string;
  port: number;
  version: string;
}

export const peers = signal<PeerViewer[]>([]);

const PROBE_WINDOW = 10;
const PROBE_TIMEOUT_MS = 400;

async function probe(port: number): Promise<PeerViewer | null> {
  const url = `http://${location.hostname}:${port}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`${url}/api/v1/health`, {
      signal: ctrl.signal,
      // Don't carry the session cookie — we only need the public
      // health signal, and cross-port fetches wouldn't see our
      // cookie on most browsers anyway.
      credentials: "omit",
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      agent?: "openclaw" | "hermes";
      version?: string;
    };
    if (!body.agent) return null;
    return {
      agent: body.agent,
      version: body.version ?? "?",
      url,
      port,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan the ports around ours for other viewer instances. Called once
 * on app mount and again whenever the user opens the agent switcher
 * in the header.
 */
export async function discoverPeers(): Promise<void> {
  const selfPort = Number(location.port) || 80;
  const candidates: number[] = [];
  for (let d = 1; d <= PROBE_WINDOW; d++) {
    candidates.push(selfPort + d);
    if (selfPort - d >= 1024) candidates.push(selfPort - d);
  }
  const selfAgent = selfHealth.value?.agent ?? null;
  const results = await Promise.all(candidates.map((p) => probe(p)));
  // Drop null + drop duplicates of our own agent on other ports.
  const seen = new Set<string>();
  const out: PeerViewer[] = [];
  for (const r of results) {
    if (!r) continue;
    if (r.port === selfPort) continue;
    if (r.agent === selfAgent) continue; // same agent on a stray port
    const key = `${r.agent}:${r.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  peers.value = out;
}
