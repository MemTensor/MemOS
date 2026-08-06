/**
 * Multi-agent auth cookie isolation.
 *
 * Browsers do NOT isolate cookies by port. Two viewer servers running
 * on the same host (`localhost:18799` for openclaw, `localhost:18800`
 * for hermes — or `/openclaw/*` vs `/hermes/*` under one hub origin)
 * share a single cookie jar. If both servers issued a cookie under
 * the same name (`memos_sess`) with `Path=/`, logging into one would
 * silently overwrite the other's cookie and the next refresh would
 * boot the other viewer back to the LoginScreen.
 *
 * The fix is in `server/routes/auth.ts`: each server names its
 * cookie `memos_sess_<agent>` so the two coexist. This test
 * replicates the original bug scenario end-to-end and pins the new
 * behaviour against future regressions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHttpServer } from "../../../server/index.js";
import type { ServerHandle } from "../../../server/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

function stubCore(): MemoryCore {
  // Tiny stub — auth gating runs *before* core methods are reached,
  // so the methods just need to exist for type-compat.
  const noop = vi.fn(async () => ({}) as never);
  return new Proxy({} as MemoryCore, {
    get: () => noop,
  });
}

function readSetCookies(res: Response): string[] {
  // `headers.getSetCookie()` is fairly new; fall back to splitting the
  // raw header so this stays portable across runtimes.
  const anyHeaders = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

/** Extract `name=value` from a Set-Cookie header line. */
function parseCookie(line: string): { name: string; value: string } {
  const head = line.split(";")[0] ?? "";
  const eq = head.indexOf("=");
  if (eq < 0) return { name: head.trim(), value: "" };
  return {
    name: head.slice(0, eq).trim(),
    value: head.slice(eq + 1).trim(),
  };
}

/** Pick the first Set-Cookie matching `name`. */
function pickCookie(res: Response, name: string): { name: string; value: string } | null {
  for (const line of readSetCookies(res)) {
    const c = parseCookie(line);
    if (c.name === name) return c;
  }
  return null;
}

describe("auth cookie isolation across agents", () => {
  let tmpRoots: string[] = [];
  let handles: ServerHandle[] = [];

  beforeEach(() => {
    tmpRoots = [];
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        /* ignore */
      }
    }
    for (const r of tmpRoots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  async function startWith(agent: "openclaw" | "hermes"): Promise<{
    handle: ServerHandle;
    home: string;
  }> {
    const home = mkdtempSync(join(tmpdir(), `memos-auth-${agent}-`));
    tmpRoots.push(home);
    const handle = await startHttpServer(
      { core: stubCore(), home: { root: home } },
      { port: 0, agent },
    );
    handles.push(handle);
    return { handle, home };
  }

  async function setupPassword(handle: ServerHandle, password: string): Promise<Response> {
    return fetch(`${handle.url}/api/v1/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
  }

  it("openclaw issues memos_sess_openclaw, hermes issues memos_sess_hermes", async () => {
    const oc = await startWith("openclaw");
    const hm = await startWith("hermes");

    const ocSetup = await setupPassword(oc.handle, "secret-oc");
    expect(ocSetup.status).toBe(200);
    const ocCookie = pickCookie(ocSetup, "memos_sess_openclaw");
    expect(ocCookie, "openclaw must set memos_sess_openclaw").not.toBeNull();
    expect(pickCookie(ocSetup, "memos_sess")).toBeNull();

    const hmSetup = await setupPassword(hm.handle, "secret-hm");
    expect(hmSetup.status).toBe(200);
    const hmCookie = pickCookie(hmSetup, "memos_sess_hermes");
    expect(hmCookie, "hermes must set memos_sess_hermes").not.toBeNull();
    expect(pickCookie(hmSetup, "memos_sess")).toBeNull();

    // The values are different (each agent signs with its own
    // sessionSecret) and — crucially — the names are different so
    // both cookies coexist in a real browser jar.
    expect(ocCookie!.name).not.toBe(hmCookie!.name);
    expect(ocCookie!.value).not.toBe(hmCookie!.value);
  });

  it("refreshing one viewer no longer logs out the other (regression)", async () => {
    const oc = await startWith("openclaw");
    const hm = await startWith("hermes");

    const ocSetup = await setupPassword(oc.handle, "secret-oc");
    const ocCookie = pickCookie(ocSetup, "memos_sess_openclaw")!;
    const hmSetup = await setupPassword(hm.handle, "secret-hm");
    const hmCookie = pickCookie(hmSetup, "memos_sess_hermes")!;

    // Simulate a real browser tab that holds BOTH cookies in its jar
    // (because both servers share the localhost cookie scope). A
    // refresh of the openclaw viewer sends both cookies up; openclaw
    // must still see itself as authenticated.
    const combined = `memos_sess_openclaw=${ocCookie.value}; memos_sess_hermes=${hmCookie.value}`;

    const ocStatus = await fetch(`${oc.handle.url}/api/v1/auth/status`, {
      headers: { cookie: combined },
    });
    expect(ocStatus.status).toBe(200);
    const ocBody = (await ocStatus.json()) as { authenticated: boolean };
    expect(ocBody.authenticated).toBe(true);

    const hmStatus = await fetch(`${hm.handle.url}/api/v1/auth/status`, {
      headers: { cookie: combined },
    });
    expect(hmStatus.status).toBe(200);
    const hmBody = (await hmStatus.json()) as { authenticated: boolean };
    expect(hmBody.authenticated).toBe(true);
  });

  it("hermes rejects the openclaw cookie even if the user logs into openclaw last", async () => {
    const oc = await startWith("openclaw");
    const hm = await startWith("hermes");
    await setupPassword(hm.handle, "secret-hm");
    const ocSetup = await setupPassword(oc.handle, "secret-oc");
    const ocCookie = pickCookie(ocSetup, "memos_sess_openclaw")!;

    // Forge a request to hermes carrying ONLY openclaw's cookie. The
    // legacy fallback must NOT pick this up (different name, different
    // secret) — hermes must still report not authenticated.
    const hmStatus = await fetch(`${hm.handle.url}/api/v1/auth/status`, {
      headers: { cookie: `memos_sess_openclaw=${ocCookie.value}` },
    });
    expect(hmStatus.status).toBe(200);
    const hmBody = (await hmStatus.json()) as { authenticated: boolean };
    expect(hmBody.authenticated).toBe(false);
  });

  it("legacy memos_sess cookie is still accepted (smooth upgrade)", async () => {
    // Spin up a server WITHOUT an agent first — that's the path that
    // mints the legacy `memos_sess` cookie. Then re-attach to the same
    // home with `agent: 'openclaw'` and verify the legacy cookie is
    // still honoured by the per-agent server.
    const home = mkdtempSync(join(tmpdir(), "memos-auth-legacy-"));
    tmpRoots.push(home);

    const legacy = await startHttpServer(
      { core: stubCore(), home: { root: home } },
      { port: 0 }, // no `agent` → legacy cookie name
    );
    handles.push(legacy);

    const setup = await setupPassword(legacy, "secret");
    expect(setup.status).toBe(200);
    const legacyCookie = pickCookie(setup, "memos_sess");
    expect(legacyCookie, "no-agent server should mint the legacy cookie").not.toBeNull();

    await legacy.close();
    handles = handles.filter((h) => h !== legacy);

    // Same home, now exposed as openclaw. The .auth.json on disk
    // (same sessionSecret) is reused, so the legacy cookie's MAC
    // still matches and the agent-aware fallback path picks it up.
    const upgraded = await startHttpServer(
      { core: stubCore(), home: { root: home } },
      { port: 0, agent: "openclaw" },
    );
    handles.push(upgraded);

    const status = await fetch(`${upgraded.url}/api/v1/auth/status`, {
      headers: { cookie: `memos_sess=${legacyCookie!.value}` },
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });

  it("blocks /api/v1/* without a valid cookie when password is set", async () => {
    const oc = await startWith("openclaw");
    await setupPassword(oc.handle, "secret-oc");

    // No cookie at all → 401.
    const r1 = await fetch(`${oc.handle.url}/api/v1/ping`);
    expect(r1.status).toBe(401);

    // Wrong-name cookie that happens to be a valid token from another
    // agent → still 401, because the openclaw server reads its own
    // per-agent name first and only falls back to the legacy name.
    const r2 = await fetch(`${oc.handle.url}/api/v1/ping`, {
      headers: { cookie: "memos_sess_hermes=this-is-not-an-openclaw-token" },
    });
    expect(r2.status).toBe(401);
  });
});
