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

describe("init() orphan episode handling", () => {
    it("preserves open episodes for sessions that were not explicitly closed", async () => {
      pipeline = createPipeline(buildDeps(db!));
      core = createMemoryCore(
        pipeline,
        resolveHome("openclaw", "/tmp/memos-mc-test"),
        "test",
      );
      // Simulate a session still active on disk — no meta.closedAt.
      db!.repos.sessions.upsert({
        id: "s-orphan-keep",
        agent: "openclaw",
        startedAt: 1_700_000_000_000,
        lastSeenAt: 1_700_000_100_000,
        meta: {},
      });
      db!.repos.episodes.insert({
        id: "ep-orphan-keep",
        sessionId: "s-orphan-keep",
        startedAt: 1_700_000_000_000,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
        meta: {},
      });

      await core.init();

      const ep = db!.repos.episodes.getById("ep-orphan-keep");
      expect(ep).not.toBeNull();
      expect(ep!.status).toBe("open");
    });

    it("closes open episodes for sessions that were explicitly closed", async () => {
      pipeline = createPipeline(buildDeps(db!));
      core = createMemoryCore(
        pipeline,
        resolveHome("openclaw", "/tmp/memos-mc-test"),
        "test",
      );
      db!.repos.sessions.upsert({
        id: "s-orphan-close",
        agent: "openclaw",
        startedAt: 1_700_000_000_000,
        lastSeenAt: 1_700_000_200_000,
        meta: { closedAt: 1_700_000_200_000 },
      });
      db!.repos.episodes.insert({
        id: "ep-orphan-close",
        sessionId: "s-orphan-close",
        startedAt: 1_700_000_000_000,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
        meta: {},
      });

      await core.init();

      const ep = db!.repos.episodes.getById("ep-orphan-close");
      expect(ep).not.toBeNull();
      expect(ep!.status).toBe("closed");
    });

    it("closes open episodes for sessions that no longer exist", async () => {
      pipeline = createPipeline(buildDeps(db!));
      core = createMemoryCore(
        pipeline,
        resolveHome("openclaw", "/tmp/memos-mc-test"),
        "test",
      );
      // FK requires the session to exist first; we then delete it via
      // raw SQL to simulate a session row that was removed (e.g. manual
      // DB cleanup), leaving an orphan episode behind.
      db!.repos.sessions.upsert({
        id: "s-gone",
        agent: "openclaw",
        startedAt: 1_700_000_000_000,
        lastSeenAt: 1_700_000_000_000,
        meta: {},
      });
      db!.repos.episodes.insert({
        id: "ep-no-session",
        sessionId: "s-gone",
        startedAt: 1_700_000_000_000,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
        meta: {},
      });
      // Temporarily disable FK checks so we can delete the session
      // while keeping the orphan episode for the test.
      db!.db.exec("PRAGMA foreign_keys = OFF; DELETE FROM sessions WHERE id='s-gone'; PRAGMA foreign_keys = ON;");

      await core.init();

      const ep = db!.repos.episodes.getById("ep-no-session");
      expect(ep).not.toBeNull();
      expect(ep!.status).toBe("closed");
    });
  });

  describe("deleteEpisode / deleteEpisodes", () => {
    it("deletes a closed episode and returns deleted: true", async () => {
      pipeline = createPipeline(buildDeps(db!));
      core = createMemoryCore(
        pipeline,
        resolveHome("openclaw", "/tmp/memos-mc-test"),
        "test",
      );
      await core.init();
      const sid = await core.openSession({ agent: "openclaw" });
      const eid = await core.openEpisode({ sessionId: sid });
      await core.closeEpisode(eid);

      const result = await core.deleteEpisode(eid);
      expect(result.deleted).toBe(true);
      expect(db!.repos.episodes.getById(eid)).toBeNull();
    });

    it("returns deleted: false for a missing episode", async () => {
      pipeline = createPipeline(buildDeps(db!));
      core = createMemoryCore(
        pipeline,
        resolveHome("openclaw", "/tmp/memos-mc-test"),
        "test",
      );
      await core.init();

      const result = await core.deleteEpisode("ep-does-not-exist");
      expect(result.deleted).toBe(false);
    });

    it("throws conflict when deleting an open episode", async () => {
      pipeline = createPipeline(buildDeps(db!));
      core = createMemoryCore(
        pipeline,
        resolveHome("openclaw", "/tmp/memos-mc-test"),
        "test",
      );
      await core.init();
      const sid = await core.openSession({ agent: "openclaw" });
      const eid = await core.openEpisode({ sessionId: sid });

      await expect(core.deleteEpisode(eid)).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("deleteEpisodes bulk-deletes multiple closed episodes", async () => {
      pipeline = createPipeline(buildDeps(db!));
      core = createMemoryCore(
        pipeline,
        resolveHome("openclaw", "/tmp/memos-mc-test"),
        "test",
      );
      await core.init();
      const sid = await core.openSession({ agent: "openclaw" });
      const e1 = await core.openEpisode({ sessionId: sid });
      const e2 = await core.openEpisode({ sessionId: sid });
      await core.closeEpisode(e1);
      await core.closeEpisode(e2);

      const result = await core.deleteEpisodes([e1, e2]);
      expect(result.deleted).toBe(2);
      expect(db!.repos.episodes.getById(e1)).toBeNull();
      expect(db!.repos.episodes.getById(e2)).toBeNull();
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
});
