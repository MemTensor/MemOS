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
import {
  restartState,
  triggerCleared,
  triggerRestart,
} from "../../../viewer/src/stores/restart";

describe("viewer restart flow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeWindow.location.href = "";
    health.value = { ok: true, agent: "hermes" };
    restartState.value = { phase: "idle" };
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

  it("shows the manual restart state returned by Windows restart", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          restarting: false,
          manualRestartRequired: true,
          message: "Close and reopen Hermes.",
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    await triggerRestart();

    expect(restartState.value).toEqual({
      phase: "manualRestartRequired",
      message: "Close and reopen Hermes.",
    });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(fakeWindow.location.href).toBe("");
  });

  it("shows the manual restart state returned by Windows clear-data", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 200 }),
    ) as typeof fetch;

    const clearing = triggerCleared({
      ok: true,
      restarting: false,
      manualRestartRequired: true,
      message: "Restart Hermes manually.",
    });
    await vi.runAllTimersAsync();
    await clearing;

    expect(restartState.value).toEqual({
      phase: "manualRestartRequired",
      message: "Restart Hermes manually.",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fakeWindow.location.href).toBe("");
  });
});
