import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/storage/sqlite";
import { Embedder } from "../src/embedding";
import { initPlugin } from "../src/index";
import { parseArgs, runReembed } from "../scripts/re-embed";
import type { Chunk, Logger, EmbeddingConfig } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let store: SqliteStore;
let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-reembed-test-"));
  dbPath = path.join(tmpDir, "test.db");
  store = new SqliteStore(dbPath, noopLog);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: overrides.id ?? "chunk-1",
    sessionKey: overrides.sessionKey ?? "session-1",
    turnId: "turn-1",
    seq: 0,
    role: "user",
    content: "Hello world",
    kind: "paragraph",
    summary: "Greeting",
    embedding: null,
    taskId: null,
    skillId: null,
    owner: "agent:main",
    dedupStatus: "active",
    dedupTarget: null,
    dedupReason: null,
    mergeCount: 0,
    lastHitAt: null,
    mergeHistory: "[]",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function rawEmbeddingRow(p: string, chunkId: string): {
  provider: string;
  model: string;
  dimensions: number;
} | undefined {
  const db = new Database(p, { readonly: true });
  try {
    return db
      .prepare("SELECT provider, model, dimensions FROM embeddings WHERE chunk_id = ?")
      .get(chunkId) as
      | { provider: string; model: string; dimensions: number }
      | undefined;
  } finally {
    db.close();
  }
}

describe("Embedding producer columns (TC-1, TC-2, TC-3)", () => {
  it("migration adds provider + model columns with NOT NULL DEFAULT ''", () => {
    const dbRO = new Database(dbPath, { readonly: true });
    try {
      const cols = dbRO.prepare("PRAGMA table_info(embeddings)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const provider = cols.find((c) => c.name === "provider");
      const model = cols.find((c) => c.name === "model");
      expect(provider, "embeddings.provider column should exist").toBeDefined();
      expect(model, "embeddings.model column should exist").toBeDefined();
      expect(provider!.notnull).toBe(1);
      expect(model!.notnull).toBe(1);
      expect(provider!.dflt_value).toMatch(/''|""/);
      expect(model!.dflt_value).toMatch(/''|""/);
    } finally {
      dbRO.close();
    }
  });

  it("upsertEmbedding without producer (back-compat) stores empty strings", () => {
    store.insertChunk(makeChunk({ id: "c1" }));
    store.upsertEmbedding("c1", [0.1, 0.2, 0.3]);

    const row = rawEmbeddingRow(dbPath, "c1");
    expect(row).toBeDefined();
    expect(row!.provider).toBe("");
    expect(row!.model).toBe("");
    expect(row!.dimensions).toBe(3);

    const v = store.getEmbedding("c1");
    expect(v).not.toBeNull();
    expect(v!).toHaveLength(3);
    expect(v![0]).toBeCloseTo(0.1, 5);
  });

  it("upsertEmbedding with producer persists provider + model", () => {
    store.insertChunk(makeChunk({ id: "c1" }));
    store.upsertEmbedding("c1", [0.1, 0.2, 0.3], {
      provider: "openai",
      model: "text-embedding-3-small",
    });

    const row = rawEmbeddingRow(dbPath, "c1");
    expect(row).toBeDefined();
    expect(row!.provider).toBe("openai");
    expect(row!.model).toBe("text-embedding-3-small");
    expect(row!.dimensions).toBe(3);

    // overwrite with a different producer
    store.upsertEmbedding("c1", [0.4, 0.5, 0.6], {
      provider: "openai",
      model: "text-embedding-3-large",
    });
    const row2 = rawEmbeddingRow(dbPath, "c1");
    expect(row2!.model).toBe("text-embedding-3-large");
  });
});

describe("getEmbeddingStats + listChunkIdsForReembed (TC-4, TC-5, TC-6)", () => {
  beforeEach(() => {
    // 6 chunks total. 5 with embeddings, 1 without.
    const now = Date.now();
    store.insertChunk(makeChunk({ id: "c1", createdAt: now + 1 }));
    store.insertChunk(makeChunk({ id: "c2", createdAt: now + 2 }));
    store.insertChunk(makeChunk({ id: "c3", createdAt: now + 3 }));
    store.insertChunk(makeChunk({ id: "c4", createdAt: now + 4 }));
    store.insertChunk(makeChunk({ id: "c5", createdAt: now + 5 }));
    store.insertChunk(makeChunk({ id: "c6", createdAt: now + 6 })); // no embedding

    // matched (×2): openai/text-embedding-3-small/1536
    store.upsertEmbedding("c1", Array(1536).fill(0.1), {
      provider: "openai",
      model: "text-embedding-3-small",
    });
    store.upsertEmbedding("c2", Array(1536).fill(0.2), {
      provider: "openai",
      model: "text-embedding-3-small",
    });
    // mismatched: different model
    store.upsertEmbedding("c3", Array(3072).fill(0.3), {
      provider: "openai",
      model: "text-embedding-3-large",
    });
    // mismatched: different provider
    store.upsertEmbedding("c4", Array(384).fill(0.4), {
      provider: "local",
      model: "",
    });
    // legacy: no producer info
    store.upsertEmbedding("c5", Array(1536).fill(0.5));
  });

  it("getEmbeddingStats reports matched/mismatched/legacy/missing", () => {
    const stats = store.getEmbeddingStats({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    expect(stats.total).toBe(5);
    expect(stats.matched).toBe(2);
    // c3 + c4 are explicit mismatch (both have non-empty provider != current)
    expect(stats.mismatched).toBe(2);
    expect(stats.legacy).toBe(1);
    expect(stats.missing).toBe(1); // c6 has chunk but no embedding row

    expect(stats.current.provider).toBe("openai");
    expect(stats.current.model).toBe("text-embedding-3-small");
    expect(stats.current.dimensions).toBe(1536);

    // byProducer has all three buckets
    const producers = stats.byProducer.map((b) => `${b.provider}|${b.model}|${b.dimensions}`).sort();
    expect(producers).toEqual([
      "||1536",
      "local||384",
      "openai|text-embedding-3-large|3072",
      "openai|text-embedding-3-small|1536",
    ].sort());
  });

  it("listChunkIdsForReembed default returns mismatched + legacy + missing", () => {
    const ids = store.listChunkIdsForReembed({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(new Set(ids)).toEqual(new Set(["c3", "c4", "c5", "c6"]));
  });

  it("listChunkIdsForReembed missingOnly returns only chunks without embedding row", () => {
    const ids = store.listChunkIdsForReembed(
      {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      { missingOnly: true },
    );
    expect(ids).toEqual(["c6"]);
  });

  it("listChunkIdsForReembed respects limit", () => {
    const ids = store.listChunkIdsForReembed(
      {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      { limit: 2 },
    );
    expect(ids.length).toBe(2);
  });
});

describe("Embedder.signature (TC-7)", () => {
  it("returns provider:model:dimensions for an explicit config", () => {
    const cfg: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };
    const e = new Embedder(cfg, noopLog);
    expect(e.signature).toBe("openai:text-embedding-3-small:1536");
    expect(e.model).toBe("text-embedding-3-small");
  });

  it("falls back to local::384 when config is undefined", () => {
    const e = new Embedder(undefined, noopLog);
    expect(e.signature).toBe("local::384");
    expect(e.provider).toBe("local");
    expect(e.model).toBe("");
    expect(e.dimensions).toBe(384);
  });

  it("treats openclaw provider without hostEmbedding as local", () => {
    const cfg: EmbeddingConfig = {
      provider: "openclaw",
      model: "any",
      dimensions: 1536,
      capabilities: { hostEmbedding: false },
    };
    const e = new Embedder(cfg, noopLog);
    // provider downshifts to "local", model still surfaces; signature is canonical for current Embedder identity
    expect(e.provider).toBe("local");
    expect(e.signature.startsWith("local:")).toBe(true);
  });
});

describe("Init-time mismatch warning (TC-9)", () => {
  it("emits a warn line when legacy or mismatched rows are present", () => {
    // 1. Pre-create the DB with one legacy embedding row
    const initStore = new SqliteStore(dbPath, noopLog);
    initStore.insertChunk(makeChunk({ id: "c-legacy" }));
    initStore.upsertEmbedding("c-legacy", Array(1536).fill(0.1));
    initStore.close();

    // 2. Build a log that captures warn calls
    const warns: string[] = [];
    const captureLog: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => warns.push(String(msg)),
      error: () => {},
    };

    // 3. Spin up initPlugin pointing at the same DB with a fresh config
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const plugin = initPlugin({
      stateDir,
      workspaceDir: tmpDir,
      config: {
        storage: { dbPath },
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
        },
      },
      log: captureLog,
    });

    // 4. Expect at least one warn mentioning legacy / mismatch and the script path
    expect(warns.some((w) => /embedding model mismatch/i.test(w))).toBe(true);
    expect(warns.some((w) => /scripts\/re-embed\.ts/.test(w))).toBe(true);

    // shutdown is async; tests don't need to await on it
    void plugin.shutdown();
  });

  it("stays quiet when the DB has no embeddings at all", () => {
    const warns: string[] = [];
    const captureLog: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => warns.push(String(msg)),
      error: () => {},
    };
    const stateDir = path.join(tmpDir, "state2");
    fs.mkdirSync(stateDir, { recursive: true });
    const plugin = initPlugin({
      stateDir,
      workspaceDir: tmpDir,
      config: {
        storage: { dbPath: path.join(stateDir, "empty.db") },
        embedding: { provider: "openai", model: "x", dimensions: 1536 },
      },
      log: captureLog,
    });

    expect(warns.some((w) => /embedding model mismatch/i.test(w))).toBe(false);
    void plugin.shutdown();
  });
});

describe("re-embed CLI", () => {
  it("parseArgs supports the documented flags", () => {
    const opts = parseArgs([
      "--missing-only",
      "--dry-run",
      "--limit",
      "5",
      "--batch-size",
      "2",
      "--db",
      "/tmp/foo.db",
      "--config",
      "/tmp/openclaw.json",
    ]);
    expect(opts.missingOnly).toBe(true);
    expect(opts.dryRun).toBe(true);
    expect(opts.limit).toBe(5);
    expect(opts.batchSize).toBe(2);
    expect(opts.dbPath).toBe("/tmp/foo.db");
    expect(opts.configPath).toBe("/tmp/openclaw.json");
  });

  it("parseArgs rejects unknown args", () => {
    expect(() => parseArgs(["--what"])).toThrow(/Unknown argument/);
  });

  it("dry-run reports planned count and writes nothing", async () => {
    // Build a DB with: 1 matched, 1 mismatched, 1 missing.
    const setup = new SqliteStore(dbPath, noopLog);
    setup.insertChunk(makeChunk({ id: "c1" }));
    setup.insertChunk(makeChunk({ id: "c2" }));
    setup.insertChunk(makeChunk({ id: "c3" })); // no embedding
    setup.upsertEmbedding("c1", Array(8).fill(0.1), {
      provider: "local",
      model: "",
    });
    setup.upsertEmbedding("c2", Array(8).fill(0.2), {
      provider: "openai",
      model: "old-model",
    });
    setup.close();

    // Write a minimal openclaw.json the script can read
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(tmpDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            "memos-local": {
              config: {
                storage: { dbPath },
                // No `embedding` block → local fallback (dim 384)
              },
            },
          },
        },
      }),
    );

    const result = await runReembed({
      configPath,
      dbPath,
      missingOnly: false,
      dryRun: true,
      batchSize: 32,
      help: false,
    });
    // planned = c1 mismatched (local|||8 vs local||384) + c2 mismatched + c3 missing = 3
    expect(result.planned).toBe(3);
    expect(result.processed).toBe(0);

    // Verify the DB embeddings table is unchanged
    const checkDb = new Database(dbPath, { readonly: true });
    const rows = checkDb.prepare("SELECT chunk_id, provider, model FROM embeddings ORDER BY chunk_id").all();
    checkDb.close();
    expect(rows).toEqual([
      { chunk_id: "c1", provider: "local", model: "" },
      { chunk_id: "c2", provider: "openai", model: "old-model" },
    ]);
  });
});
