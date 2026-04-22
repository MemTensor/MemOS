/**
 * Unit tests for the viewer's hash-based router.
 *
 * We stub `window` + `location` to exercise the parse/navigate flow
 * without needing jsdom. The router is deliberately simple — a single
 * `route` signal reflecting `window.location.hash`.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const listeners = new Map<string, Array<() => void>>();
const fakeWindow = {
  location: { hash: "" },
  addEventListener(type: string, cb: () => void) {
    const list = listeners.get(type) ?? [];
    list.push(cb);
    listeners.set(type, list);
  },
  removeEventListener() {},
};

let route: { value: { path: string; params: Record<string, string> } };
let navigate: (path: string, params?: Record<string, string>) => void;

beforeAll(async () => {
  (globalThis as any).window = fakeWindow;
  (globalThis as any).localStorage = {
    _s: new Map<string, string>(),
    getItem(k: string) { return this._s.get(k) ?? null; },
    setItem(k: string, v: string) { this._s.set(k, v); },
    removeItem(k: string) { this._s.delete(k); },
  };
  const mod = await import("../../../web/src/stores/router");
  route = mod.route;
  navigate = mod.navigate;
});

function trigger(type: string): void {
  const cbs = listeners.get(type) ?? [];
  for (const cb of cbs) cb();
}

describe("router", () => {
  beforeEach(() => {
    fakeWindow.location.hash = "";
    trigger("hashchange");
  });

  it("defaults to /overview when hash is empty", () => {
    expect(route.value.path).toBe("/overview");
    expect(route.value.params).toEqual({});
  });

  it("parses hash with path + params", () => {
    fakeWindow.location.hash = "#/memories?q=hello%20world&tier=2";
    trigger("hashchange");
    expect(route.value.path).toBe("/memories");
    expect(route.value.params.q).toBe("hello world");
    expect(route.value.params.tier).toBe("2");
  });

  it("navigate() writes to location.hash and re-parses", () => {
    navigate("/skills", { status: "active" });
    // Trigger the listener like the browser would.
    trigger("hashchange");
    expect(fakeWindow.location.hash).toBe("#/skills?status=active");
    expect(route.value.path).toBe("/skills");
    expect(route.value.params.status).toBe("active");
  });
});
