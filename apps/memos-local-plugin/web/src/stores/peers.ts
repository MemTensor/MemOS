/**
 * Peer agent discovery — dual-port edition.
 *
 * Each agent runs its own viewer on a well-known port:
 *
 *   - openclaw → :18799
 *   - hermes   → :18800
 *
 * If the *other* agent's viewer is up we surface a small pill in the
 * header that links to it (external; opens in a new tab). We probe
 * the well-known port directly — no port scanning, no IPC, no
 * server-side hand-off.
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

const PROBE_TIMEOUT_MS = 400;

const PEER_PORTS: Record<"openclaw" | "hermes", number> = {
  openclaw: 18799,
  hermes: 18800,
};

async function probe(
  agent: "openclaw" | "hermes",
  port: number,
): Promise<PeerViewer | null> {
  const url = `http://${location.hostname}:${port}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`${url}/api/v1/health`, {
      signal: ctrl.signal,
      // Cross-port loopback fetches don't carry our session cookie
      // anyway; explicit `omit` keeps that intent visible.
      credentials: "omit",
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      agent?: "openclaw" | "hermes";
      version?: string;
    };
    if (body.agent !== agent) return null;
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
 * Probe the peer agent's well-known port. Called once on app mount
 * and again whenever the user opens the header switcher.
 */
export async function discoverPeers(): Promise<void> {
  const selfAgent = selfHealth.value?.agent ?? null;
  if (!selfAgent) {
    peers.value = [];
    return;
  }
  const peerAgent: "openclaw" | "hermes" =
    selfAgent === "openclaw" ? "hermes" : "openclaw";
  const found = await probe(peerAgent, PEER_PORTS[peerAgent]);
  peers.value = found ? [found] : [];
}
