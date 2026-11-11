/**
 * Sign in with ChatGPT credentials: refresh, rotation, cross-process lock,
 * recovery and host ID. Synthetic token files in a temp folder only.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChatGptAuthError,
  getAccessToken,
  getOrCreateHostId,
  hostIdFile,
  isValidHostId,
} from "../../../core/llm/chatgpt-auth.js";

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const NOW = 5_000_000;
const dirs: string[] = [];

async function tokenFixture(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "memos-chatgpt-test-"));
  dirs.push(dir);
  const file = join(dir, "chatgpt-oauth.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      issuer: "https://auth.openai.com",
      client_id: "oaiapp_test",
      ext_agent_host_id: "urn:uuid:11111111-1111-4111-8111-111111111111",
      access_token: "synthetic-access-1",
      refresh_token: "synthetic-refresh-1",
      expires_at: NOW + 60_000, // inside the 5-minute refresh margin
      scopes: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
      saved_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }),
  );
  return { dir, file };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("chatgpt-auth getAccessToken", () => {
  it("refreshes near expiry, rotates both tokens, and parallel callers refresh only once", async () => {
    const { file } = await tokenFixture();
    let refreshes = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      refreshes++;
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("client_id")).toBe("oaiapp_test");
      expect(form.get("resource")).toBe("https://api.openai.com/v1");
      expect(form.get("scope")).toBeNull();
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(
        { access_token: "synthetic-access-2", refresh_token: "synthetic-refresh-2", expires_in: 3600 },
        200,
      );
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      getAccessToken({ file, fetchImpl, now: () => NOW }),
      getAccessToken({ file, fetchImpl, now: () => NOW }),
    ]);
    expect(refreshes).toBe(1);
    expect(a.accessToken).toBe("synthetic-access-2");
    expect(b.accessToken).toBe("synthetic-access-2");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.refresh_token).toBe("synthetic-refresh-2");
    expect(saved.expires_at).toBe(NOW + 3_600_000);
  });

  it("returns a fresh token without any network call", async () => {
    const { file } = await tokenFixture({ expires_at: NOW + 3_000_000 });
    const fetchImpl = (async () => {
      throw new Error("no fetch expected");
    }) as unknown as typeof fetch;
    const t = await getAccessToken({ file, fetchImpl, now: () => NOW });
    expect(t.accessToken).toBe("synthetic-access-1");
  });

  it("clears tokens and asks for sign-in on invalid_grant", async () => {
    const { file } = await tokenFixture();
    await expect(
      getAccessToken({
        file,
        now: () => NOW,
        fetchImpl: (async () => jsonResponse({ error: "invalid_grant" }, 400)) as unknown as typeof fetch,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ChatGptAuthError && e.kind === "reauth_required");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.reauth_required).toBe(true);
    expect(saved.refresh_token).toBe("");
    expect(saved.client_id).toBe("oaiapp_test"); // kept for re-sign-in
  });

  it("leaves the token file untouched on a transient refresh error", async () => {
    const { file } = await tokenFixture();
    const before = await readFile(file, "utf8");
    await expect(
      getAccessToken({
        file,
        now: () => NOW,
        fetchImpl: (async () => jsonResponse({}, 502)) as unknown as typeof fetch,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ChatGptAuthError && e.kind === "transient");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("reports not_signed_in when the token file is missing", async () => {
    await expect(
      getAccessToken({ file: join(tmpdir(), "memos-chatgpt-missing-token-file.json") }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ChatGptAuthError && e.kind === "not_signed_in");
  });

  it("rejects a grant without the plan scope", async () => {
    const { file } = await tokenFixture({ scopes: ["openid", "offline_access"], expires_at: NOW + 3_000_000 });
    await expect(getAccessToken({ file, now: () => NOW })).rejects.toSatisfy(
      (e: unknown) => e instanceof ChatGptAuthError && e.kind === "missing_scope",
    );
  });
});

describe("chatgpt-auth host ID", () => {
  it("creates a urn:uuid v4 once, persists it, reuses it, and replaces an invalid legacy value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memos-chatgpt-hostid-"));
    dirs.push(dir);
    const file = join(dir, "chatgpt-oauth.json");
    const a = await getOrCreateHostId(file);
    expect(a).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await readFile(hostIdFile(file), "utf8")).trim()).toBe(a);
    expect(await getOrCreateHostId(file)).toBe(a);
    expect(await getOrCreateHostId(file, "memos-local-old-format")).toBe(a);
    const given = "urn:uuid:22222222-2222-4222-8222-222222222222";
    expect(await getOrCreateHostId(file, given)).toBe(given);
  });

  it("accepts only the documented opaque formats", () => {
    expect(isValidHostId("did:key:z6Mk")).toBe(true);
    expect(isValidHostId("urn:ietf:params:oauth:jwk-thumbprint:sha-256:abc")).toBe(true);
    expect(isValidHostId("someone@example.com")).toBe(false);
    expect(isValidHostId(undefined)).toBe(false);
  });
});
