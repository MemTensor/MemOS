import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeWindow = {
  location: {
    pathname: "/",
    href: "",
  },
};

(globalThis as any).window = fakeWindow;
(globalThis as any).localStorage = {
  getItem() { return null; },
};

import { health } from "../../../viewer/src/stores/health";
import { triggerRestart } from "../../../viewer/src/stores/restart";

describe("viewer restart flow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeWindow.location.href = "";
    health.value = { ok: true, agent: "hermes" };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("waits for the replacement Hermes daemon before reloading", async () => {
    let healthChecks = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, restarting: true }), {
          status: 200,
        });
      }
      healthChecks += 1;
      if (healthChecks === 1) throw new TypeError("daemon is down");
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const restarting = triggerRestart();
    await vi.runAllTimersAsync();
    await restarting;

    expect(healthChecks).toBe(2);
    expect(fakeWindow.location.href).toMatch(/^\/\?_t=\d+$/);
  });
});
