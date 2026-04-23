/**
 * Multi-agent hub routes + peer registry.
 *
 * When the first agent plugin boots and successfully binds port
 * 18799, it becomes the **hub**. Subsequent agent plugins that find
 * 18799 occupied bind a fallback port and POST here with their
 * metadata. The hub then reverse-proxies `/{peerAgent}/*` requests
 * to the peer's fallback port, giving users a single URL surface
 * (`127.0.0.1:18799/openclaw/…` + `127.0.0.1:18799/hermes/…`).
 *
 * The registry is intentionally in-memory and unauthenticated — it
 * only accepts registrations from loopback, and it's dropped on
 * process restart (at which point peers re-register on their own
 * health loop).
 *
 * Endpoints (always available; not agent-scoped):
 *   - `POST /api/v1/hub/register  { agent, port, version? }`
 *   - `POST /api/v1/hub/deregister { agent }`
 *   - `GET  /api/v1/hub/peers`                    → { self, peers }
 */
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export interface PeerInfo {
  agent: "openclaw" | "hermes";
  port: number;
  version: string;
  registeredAt: number;
}

/** Module-global registry. Reset implicitly on process restart. */
const peers = new Map<string, PeerInfo>();

export function getPeer(agent: string): PeerInfo | undefined {
  return peers.get(agent);
}

export function listPeers(): PeerInfo[] {
  return [...peers.values()];
}

export function registerPeer(info: Omit<PeerInfo, "registeredAt">): void {
  peers.set(info.agent, { ...info, registeredAt: Date.now() });
}

export function deregisterPeer(agent: string): void {
  peers.delete(agent);
}

export function registerHubRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("POST /api/v1/hub/register", async (ctx) => {
    const body = parseJson<{
      agent?: string;
      port?: number;
      version?: string;
    }>(ctx);
    const agent = body.agent;
    const port = body.port;
    if (agent !== "openclaw" && agent !== "hermes") {
      writeError(
        ctx,
        400,
        "invalid_argument",
        "agent must be 'openclaw' or 'hermes'",
      );
      return;
    }
    if (!Number.isInteger(port) || !port || port < 1024 || port > 65535) {
      writeError(ctx, 400, "invalid_argument", "port must be a valid tcp port");
      return;
    }
    // Loopback-only: reject registrations from non-local peers.
    const remote = ctx.req.socket.remoteAddress ?? "";
    if (!isLoopback(remote)) {
      writeError(ctx, 403, "forbidden", `registration not allowed from ${remote}`);
      return;
    }
    registerPeer({
      agent,
      port: port!,
      version: body.version ?? "?",
    });
    return { ok: true, registered: { agent, port } };
  });

  routes.set("POST /api/v1/hub/deregister", async (ctx) => {
    const body = parseJson<{ agent?: string }>(ctx);
    if (!body.agent) {
      writeError(ctx, 400, "invalid_argument", "agent is required");
      return;
    }
    deregisterPeer(body.agent);
    return { ok: true };
  });

  routes.set("GET /api/v1/hub/peers", async () => {
    return {
      self: {
        agent: deps.home ? pickSelfAgent() : null,
      },
      peers: listPeers(),
    };
  });
}

function isLoopback(addr: string): boolean {
  if (!addr) return false;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") {
    return true;
  }
  return false;
}

// Hub self-agent is injected via `options.agent` on the server;
// ServerDeps doesn't carry it so we leave null here — callers can
// read it via `/api/v1/health.agent` instead.
function pickSelfAgent(): null {
  return null;
}
