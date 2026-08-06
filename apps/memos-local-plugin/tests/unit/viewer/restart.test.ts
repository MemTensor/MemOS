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
  beginClearData,
  markClearResultUnknown,
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

  it("stops polling when Windows requires a manual restart", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      restarting: false,
      manualRestartRequired: true,
      platform: "win32",
      message: "Close Hermes and start it again.",
    }), { status: 200 })) as typeof fetch;

    await triggerRestart();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(restartState.value).toEqual({
      phase: "manualRestartRequired",
      message: "Close Hermes and start it again.",
    });
    expect(fakeWindow.location.href).toBe("");
  });

  it("asks the user to close Hermes before retrying Windows clear-data", async () => {
    await triggerCleared({
      ok: false,
      manualCloseRequired: true,
      platform: "win32",
      message: "Close Hermes completely, then retry clearing data.",
    });

    expect(restartState.value).toEqual({
      phase: "manualCloseRequired",
    });
    expect(fakeWindow.location.href).toBe("");
  });

  it("stops polling after Windows clear-data requires a manual restart", async () => {
    await triggerCleared({
      ok: true,
      cleared: true,
      restarting: false,
      manualRestartRequired: true,
      platform: "win32",
      message: "Data cleared. Start Hermes again to restart Memory Viewer.",
    });

    expect(restartState.value).toEqual({
      phase: "manualClearRestartRequired",
    });
    expect(fakeWindow.location.href).toBe("");
  });

  it("does not report success when Windows could not fully clear the database", async () => {
    await triggerCleared({
      ok: false,
      cleared: false,
      restarting: false,
      manualRestartRequired: true,
      platform: "win32",
      message: "Data was not fully cleared.",
    });

    expect(restartState.value).toEqual({ phase: "clearFailed" });
  });

  it("clears a stale close-Hermes prompt as soon as clear-data is retried", () => {
    restartState.value = {
      phase: "manualCloseRequired",
      message: "stale first-attempt message",
    };

    beginClearData();

    expect(restartState.value).toEqual({ phase: "clearing" });
  });

  it("uses a conservative unknown-result state when the clear request disconnects", () => {
    restartState.value = {
      phase: "manualCloseRequired",
      message: "stale first-attempt message",
    };

    beginClearData();
    markClearResultUnknown();

    expect(restartState.value).toEqual({ phase: "clearResultUnknown" });
  });
});
