import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { Telemetry } from "../../../core/telemetry/sender.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-test-"));
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

describe("Telemetry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("opt-out", () => {
    it("does not buffer events when enabled=false", () => {
      const tel = new Telemetry({ enabled: false }, tmpDir, "1.0.0", makeLogger(), tmpDir);
      tel.trackPluginStarted("hermes");
      tel.trackTurnStart("hermes", 100, 5);
      tel.trackMemorySearch("hermes", 50, 3);
      // flush should be a no-op; fetch is never called
      return tel.shutdown().then(() => {
        expect(fetch).not.toHaveBeenCalled();
      });
    });

    it("does not buffer events when credentials are missing", () => {
      // No credentials file and no env vars → disabled
      const tel = new Telemetry({ enabled: true }, tmpDir, "1.0.0", makeLogger());
      tel.trackPluginStarted("hermes");
      return tel.shutdown().then(() => {
        expect(fetch).not.toHaveBeenCalled();
      });
    });
  });

  describe("batch flush", () => {
    beforeEach(() => {
      // Create a credentials file so telemetry enables
      const credsDir = path.join(tmpDir, "memos-local");
      fs.mkdirSync(credsDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "telemetry.credentials.json"),
        JSON.stringify({ endpoint: "https://arms.test/rum", pid: "test-pid", env: "test" }),
      );
    });

    it("flushes at 10 events", async () => {
      const tel = new Telemetry({ enabled: true }, tmpDir, "2.0.0-beta.5", makeLogger(), tmpDir);
      for (let i = 0; i < 10; i++) {
        tel.trackTurnStart("hermes", 100 + i, i);
      }
      // Wait for microtask queue to process the auto-flush
      await new Promise((r) => setTimeout(r, 10));
      expect(fetch).toHaveBeenCalledTimes(1);
      await tel.shutdown();
    });

    it("flushes remaining buffer on shutdown", async () => {
      const tel = new Telemetry({ enabled: true }, tmpDir, "2.0.0-beta.5", makeLogger(), tmpDir);
      tel.trackPluginStarted("hermes");
      tel.trackViewerOpened();
      expect(fetch).not.toHaveBeenCalled();
      await tel.shutdown();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("payload shape", () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(tmpDir, "telemetry.credentials.json"),
        JSON.stringify({ endpoint: "https://arms.test/rum", pid: "test-pid", env: "test" }),
      );
    });

    it("produces correct group and view.name", async () => {
      const tel = new Telemetry({ enabled: true }, tmpDir, "2.0.0-beta.5", makeLogger(), tmpDir);
      tel.trackPluginStarted("hermes");
      await tel.shutdown();

      expect(fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.view.name).toBe("memos-local-hermes-v2");
      expect(body.app.id).toBe("test-pid");
      expect(body.app.env).toBe("test");
      expect(body.events).toHaveLength(2); // plugin_started + daily_active
      expect(body.events[0].group).toBe("memos_local_hermes_v2");
      expect(body.events[0].type).toBe("memos_plugin");
      expect(body.events[0].name).toBe("plugin_started");
    });

    it("never leaks memory content in properties", async () => {
      const tel = new Telemetry({ enabled: true }, tmpDir, "2.0.0-beta.5", makeLogger(), tmpDir);
      tel.trackTurnStart("hermes", 200, 3);
      tel.trackMemorySearch("hermes", 150, 5);
      tel.trackFeedback("hermes", "positive");
      tel.trackTurnEnd("hermes", 2);
      tel.trackError("bridge", "timeout");
      await tel.shutdown();

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      for (const event of body.events) {
        const props = event.properties;
        expect(props).not.toHaveProperty("query");
        expect(props).not.toHaveProperty("content");
        expect(props).not.toHaveProperty("userText");
        expect(props).not.toHaveProperty("snippet");
        // Should always have base props
        expect(props).toHaveProperty("plugin_version", "2.0.0-beta.5");
        expect(props).toHaveProperty("os");
        expect(props).toHaveProperty("node_version");
      }
    });

    it("includes agent_name in turn events", async () => {
      const tel = new Telemetry({ enabled: true }, tmpDir, "2.0.0-beta.5", makeLogger(), tmpDir);
      tel.trackTurnStart("hermes", 100, 2);
      await tel.shutdown();

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      const event = body.events[0];
      expect(event.name).toBe("memos_search");
      expect(event.properties.agent_name).toBe("hermes");
      expect(event.properties.type).toBe("turn_start");
      expect(event.properties.latency_ms).toBe(100);
      expect(event.properties.hit_count).toBe(2);
    });
  });

  describe("session and identity persistence", () => {
    it("persists anonymous ID across instances", () => {
      const log = makeLogger();
      fs.writeFileSync(
        path.join(tmpDir, "telemetry.credentials.json"),
        JSON.stringify({ endpoint: "https://arms.test/rum", pid: "p", env: "test" }),
      );

      const tel1 = new Telemetry({ enabled: true }, tmpDir, "1.0.0", log, tmpDir);
      const tel2 = new Telemetry({ enabled: true }, tmpDir, "1.0.0", log, tmpDir);

      // Both should use the same anonymous ID (read from the same file)
      tel1.trackPluginStarted("hermes");
      tel2.trackPluginStarted("hermes");

      return Promise.all([tel1.shutdown(), tel2.shutdown()]).then(() => {
        const calls = (fetch as any).mock.calls;
        const body1 = JSON.parse(calls[0][1].body);
        const body2 = JSON.parse(calls[1][1].body);
        expect(body1.user.id).toBe(body2.user.id);
        expect(body1.user.id).toHaveLength(36); // UUID format
      });
    });
  });

  // Regression: previously `dailyPingSent` was an in-memory boolean,
  // so every `bridge.cts` subprocess (Hermes spawns one per `chat`)
  // re-emitted `daily_active`, making the metric track process
  // launches instead of unique active days. The fix persists the
  // last ping date to `<stateDir>/memos-local/.last-daily-ping`.
  describe("daily_active dedup persistence", () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(tmpDir, "telemetry.credentials.json"),
        JSON.stringify({ endpoint: "https://arms.test/rum", pid: "p", env: "test" }),
      );
    });

    it("emits daily_active on the first trackPluginStarted", async () => {
      const tel = new Telemetry({ enabled: true }, tmpDir, "1.0.0", makeLogger(), tmpDir);
      tel.trackPluginStarted("hermes");
      await tel.shutdown();

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      const names = body.events.map((e: any) => e.name);
      expect(names).toContain("plugin_started");
      expect(names).toContain("daily_active");
    });

    it("does NOT re-emit daily_active for a second instance the same day", async () => {
      const tel1 = new Telemetry({ enabled: true }, tmpDir, "1.0.0", makeLogger(), tmpDir);
      tel1.trackPluginStarted("hermes");
      await tel1.shutdown();

      const tel2 = new Telemetry({ enabled: true }, tmpDir, "1.0.0", makeLogger(), tmpDir);
      tel2.trackPluginStarted("hermes");
      await tel2.shutdown();

      const calls = (fetch as any).mock.calls;
      expect(calls).toHaveLength(2);
      const body1 = JSON.parse(calls[0][1].body);
      const body2 = JSON.parse(calls[1][1].body);

      const names1 = body1.events.map((e: any) => e.name);
      const names2 = body2.events.map((e: any) => e.name);

      // First instance: both events.
      expect(names1).toContain("plugin_started");
      expect(names1).toContain("daily_active");

      // Second instance same day: only plugin_started, daily_active
      // is suppressed by the on-disk `.last-daily-ping` file.
      expect(names2).toContain("plugin_started");
      expect(names2).not.toContain("daily_active");
    });

    it("re-emits daily_active when the persisted date is yesterday", async () => {
      // Pre-seed the dedup file with an older date so the "today"
      // check fails and a fresh ping is emitted.
      const stateSubdir = path.join(tmpDir, "memos-local");
      fs.mkdirSync(stateSubdir, { recursive: true });
      fs.writeFileSync(path.join(stateSubdir, ".last-daily-ping"), "2024-01-01", "utf-8");

      const tel = new Telemetry({ enabled: true }, tmpDir, "1.0.0", makeLogger(), tmpDir);
      tel.trackPluginStarted("hermes");
      await tel.shutdown();

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      const names = body.events.map((e: any) => e.name);
      expect(names).toContain("daily_active");

      // The file should now hold today's ISO date.
      const today = new Date().toISOString().slice(0, 10);
      expect(
        fs.readFileSync(path.join(stateSubdir, ".last-daily-ping"), "utf-8").trim(),
      ).toBe(today);
    });
  });
});
