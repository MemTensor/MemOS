import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { ViewerServer } from "../src/viewer/server";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let tmpDir = "";
let store: SqliteStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

describe("viewer config gating", () => {
  it("should not report openclaw providers as viewer-usable in sidecar mode", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-config-"));
    store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
    const viewer = new ViewerServer({
      store,
      embedder: { provider: "local" } as any,
      port: 19999,
      log: noopLog,
      dataDir: tmpDir,
    });

    const cfg = {
      embedding: { provider: "openclaw", capabilities: { hostEmbedding: true } },
      summarizer: { provider: "openclaw", capabilities: { hostCompletion: true } },
    } as any;

    expect((viewer as any).hasUsableEmbeddingProvider(cfg)).toBe(false);
    expect((viewer as any).hasUsableSummarizerProvider(cfg)).toBe(false);
  });

  it("serializes concurrent config writes without returning 500", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-config-race-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-home-"));
    const configDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(configDir, "openclaw.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { entries: { "memos-local-openclaw-plugin": { enabled: true, config: {} } } } }));
    const previousHome = process.env.HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.HOME = homeDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
    const viewer = new ViewerServer({
      store,
      embedder: { provider: "local" } as any,
      port: 19998,
      log: noopLog,
      dataDir: tmpDir,
    });

    const invoke = (value: number): Promise<{ status: number; body: string }> => new Promise((resolve) => {
      const req = new EventEmitter() as any;
      req.on = req.on.bind(req);
      const res = {
        writeHead: (status: number) => { result.status = status; },
        end: (body?: string) => { result.body = body ?? ""; resolve(result); },
      } as any;
      const result = { status: 200, body: "" };
      (viewer as any).handleSaveConfig(req, res);
      req.emit("data", JSON.stringify({ viewerPort: 19000 + value }));
      req.emit("end");
    });

    try {
      const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => invoke(index)));
      expect(responses.every((item) => item.status === 200)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(persisted.plugins.entries["memos-local-openclaw-plugin"].config.viewerPort).toBeGreaterThanOrEqual(19000);
      expect(persisted.plugins.entries["memos-local-openclaw-plugin"].config.viewerPort).toBeLessThan(19010);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
