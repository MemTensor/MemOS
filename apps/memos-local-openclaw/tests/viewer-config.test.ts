import { afterEach, describe, expect, it } from "vitest";
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
});
