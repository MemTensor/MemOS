/**
 * MemoryCore façade tests.
 *
 * We drive the façade through its public interface (the shape adapters
 * see). The pipeline is wrapped directly via `createMemoryCore` with a
 * hand-built `PipelineHandle` so we control clocks + providers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  bootstrapMemoryCore,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { rootLogger } from "../../../core/logger/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { makeTmpHome, type TmpHomeContext } from "../../helpers/tmp-home.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

let db: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;
let core: MemoryCore | null = null;

function buildDeps(h: TmpDbHandle): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-mc-test"),
    config: DEFAULT_CONFIG,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: DEFAULT_CONFIG.embedding.dimensions }),
    log: rootLogger.child({ channel: "test.memory-core" }),
    now: () => 1_700_000_000_000,
  };
}

beforeEach(() => {
  db = makeTmpDb();
});

afterEach(async () => {
  if (core) {
    try {
      await core.shutdown();
    } catch {
      /* ignore */
    }
    core = null;
    pipeline = null; // Pipeline is shut down by core.
  } else if (pipeline) {
    try {
      await pipeline.shutdown("test.cleanup");
    } catch {
      /* ignore */
    }
    pipeline = null;
  }
  db?.cleanup();
  db = null;
});

describe("MemoryCore façade", () => {
  it("init + health + shutdown lifecycle", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test-1.0.0",
    );
    await core.init();
    const h = await core.health();
    expect(h.ok).toBe(true);
    expect(h.version).toBe("test-1.0.0");
    expect(h.agent).toBe("openclaw");
    expect(h.paths.db.endsWith(".db") || h.paths.db.length > 0).toBe(true);
    expect(h.embedder.available).toBe(true);
    expect(h.embedder.dim).toBe(DEFAULT_CONFIG.embedding.dimensions);
    expect(h.llm.available).toBe(false);
  });

  it("openSession + closeSession roundtrip", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const sid = await core.openSession({ agent: "openclaw" });
    expect(sid).toBeTruthy();
    await core.closeSession(sid);
  });

  it("onTurnStart returns a RetrievalResultDTO with tier latencies", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const res = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "s-x",
      userText: "how do I build this project?",
      ts: 1_700_000_000_000,
    });
    expect(res.tierLatencyMs).toBeDefined();
    expect(typeof res.injectedContext).toBe("string");
    expect(res.query.query).toBe("how do I build this project?");
  });

  it("submitFeedback persists and returns a DTO", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const fb = await core.submitFeedback({
      channel: "explicit",
      polarity: "negative",
      magnitude: 0.8,
      rationale: "broken",
    });
    expect(fb.id).toBeTruthy();
    expect(fb.polarity).toBe("negative");
    expect(fb.magnitude).toBe(0.8);

    // Verify it's actually in the repo.
    expect(db!.repos.feedback.getById(fb.id)).not.toBeNull();
  });

  it("listEpisodes + timeline return empty arrays when nothing has happened", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    const eps = await core.listEpisodes({ limit: 10 });
    expect(eps.length).toBe(0);
    const tl = await core.timeline({ episodeId: "ep-missing" });
    expect(tl.length).toBe(0);
  });

  it("subscribeEvents fires on session.opened", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();

    const received: string[] = [];
    const unsub = core.subscribeEvents((e) => {
      received.push(e.type);
    });
    await core.openSession({ agent: "openclaw", sessionId: "sub-test" });
    expect(received).toContain("session.opened");
    unsub();
  });

  it("shutdown is idempotent", async () => {
    pipeline = createPipeline(buildDeps(db!));
    core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-mc-test"),
      "test",
    );
    await core.init();
    await core.shutdown();
    await core.shutdown(); // Safe.
    await expect(core.openSession({ agent: "openclaw" })).rejects.toMatchObject({
      code: "already_shut_down",
    });
  });
});

describe("bootstrapMemoryCore", () => {
  let home: TmpHomeContext | null = null;

  afterEach(async () => {
    if (core) {
      try {
        await core.shutdown();
      } catch {
        /* ignore */
      }
      core = null;
      pipeline = null;
    }
    await home?.cleanup();
    home = null;
  });

  it("boots a MemoryCore from tmp home + default config", async () => {
    home = await makeTmpHome({ agent: "openclaw" });
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "bootstrap-test",
    });
    const h = await core.health();
    expect(h.ok).toBe(false); // Not initialized yet.
    await core.init();
    const h2 = await core.health();
    expect(h2.ok).toBe(true);
    expect(h2.paths.home).toBe(home!.home.root);
    expect(h2.paths.db).toBe(home!.home.dbFile);
  });

  it("init() recovers orphaned open episodes left behind by a previous crash", async () => {
    // When the host (OpenClaw / Hermes / a daemon) is hard-killed
    // mid-conversation, no `session.end` event is fired and the open
    // episode rows in SQLite never get closed. Without recovery, those
    // rows show "激活" forever in the viewer even though no one is
    // working on them. `core.init()` sweeps the open set on boot and:
    //
    //   - Already-rewarded rows (`r_task != null`) → close + stamp
    //     `closeReason="finalized"` (the chain ran to completion before
    //     the crash; only the final status flip was lost).
    //   - Un-scored rows → close + stamp
    //     `closeReason="abandoned"` with a clear human-readable
    //     `abandonReason` ("插件上次未正常退出，启动时自动关闭未完成的任务").
    home = await makeTmpHome({ agent: "openclaw" });

    // First bootstrap: lets migrations run + schema exists. Shut it
    // down cleanly so we can seed orphans into the DB without holding
    // a write lock.
    const seeder = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "orphan-test-seed",
    });
    await seeder.init();
    await seeder.shutdown();

    // Seed two open episodes directly via SQLite — one that has been
    // partially scored (rTask set) and one that hasn't.
    const Sqlite = (await import("better-sqlite3")).default;
    const writeDb = new Sqlite(home.home.dbFile);
    const orphanOldTs = Date.now() - 60 * 60 * 1000; // 1h ago
    writeDb
      .prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("se_orphan", "openclaw", orphanOldTs, orphanOldTs, "{}");
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, NULL, '[]', NULL, 'open', '{}')`,
      )
      .run("ep_orphan_unscored", "se_orphan", orphanOldTs);
    writeDb
      .prepare(
        `INSERT INTO episodes (id, session_id, started_at, ended_at, trace_ids_json, r_task, status, meta_json) VALUES (?, ?, ?, NULL, '[]', ?, 'open', '{}')`,
      )
      .run("ep_orphan_scored", "se_orphan", orphanOldTs, 0.7);
    writeDb.close();

    // Second bootstrap + init — recovery fires inside init().
    core = await bootstrapMemoryCore({
      agent: "openclaw",
      home: home.home,
      config: home.config,
      pkgVersion: "orphan-test-recover",
    });
    await core.init();

    const readDb = new Sqlite(home.home.dbFile, { readonly: true });
    const unscored = readDb
      .prepare("SELECT status, meta_json FROM episodes WHERE id = ?")
      .get("ep_orphan_unscored") as
      | { status: string; meta_json: string }
      | undefined;
    const scored = readDb
      .prepare("SELECT status, meta_json FROM episodes WHERE id = ?")
      .get("ep_orphan_scored") as
      | { status: string; meta_json: string }
      | undefined;
    readDb.close();

    expect(unscored).toBeDefined();
    expect(unscored!.status).toBe("closed");
    const unscoredMeta = JSON.parse(unscored!.meta_json) as {
      closeReason?: string;
      abandonReason?: string;
    };
    expect(unscoredMeta.closeReason).toBe("abandoned");
    expect(unscoredMeta.abandonReason).toContain("插件上次未正常退出");

    expect(scored).toBeDefined();
    expect(scored!.status).toBe("closed");
    const scoredMeta = JSON.parse(scored!.meta_json) as {
      closeReason?: string;
      abandonReason?: string;
    };
    // Already-scored rows become "finalized" (the chain ran), so the
    // viewer can show them as "已完成" instead of "已跳过".
    expect(scoredMeta.closeReason).toBe("finalized");
    expect(scoredMeta.abandonReason).toBeFalsy();
  });
});
