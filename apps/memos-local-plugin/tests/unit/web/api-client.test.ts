/**
 * Unit tests for the viewer's REST client.
 *
 * Verifies the default-headers path, api-key propagation, uniform
 * error shape, and the three verb helpers.
 */

import { describe, it, expect, afterEach } from "vitest";

(globalThis as any).localStorage = {
  _s: new Map<string, string>(),
  getItem(k: string) { return this._s.get(k) ?? null; },
  setItem(k: string, v: string) { this._s.set(k, v); },
  removeItem(k: string) { this._s.delete(k); },
};

import { api, ApiError } from "../../../web/src/api/client";

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api (viewer REST client)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage._s.clear();
  });

  it("api.get sends correct method and parses JSON", async () => {
    let received: RequestInit | undefined;
    globalThis.fetch = (async (_u: any, init: RequestInit) => {
      received = init;
      return okResponse({ hello: "world" });
    }) as any;
    const out = await api.get<{ hello: string }>("/api/v1/x");
    expect(out.hello).toBe("world");
    expect(received?.method).toBe("GET");
    expect((received?.headers as any)["content-type"]).toBe("application/json");
  });

  it("api.post includes JSON body and api-key header when set", async () => {
    (globalThis as any).localStorage.setItem("memos.apiKey", "hunter2");
    let received: RequestInit | undefined;
    globalThis.fetch = (async (_u: any, init: RequestInit) => {
      received = init;
      return okResponse({ ok: true });
    }) as any;
    await api.post("/api/v1/y", { a: 1 });
    expect(received?.method).toBe("POST");
    expect(JSON.parse(received?.body as string)).toEqual({ a: 1 });
    expect((received?.headers as any)["x-api-key"]).toBe("hunter2");
  });

  it("throws ApiError with code+message on non-2xx", async () => {
    globalThis.fetch = (async () =>
      okResponse(
        { error: { code: "invalid_argument", message: "agent is required" } },
        400,
      )) as any;
    try {
      await api.post("/api/v1/sessions", {});
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("invalid_argument");
      expect((err as ApiError).status).toBe(400);
    }
  });

  it("falls back to http_error when server returns non-JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("plain text oops", { status: 500 })) as any;
    try {
      await api.get("/api/v1/weird");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("http_error");
      expect((err as ApiError).status).toBe(500);
    }
  });
});
