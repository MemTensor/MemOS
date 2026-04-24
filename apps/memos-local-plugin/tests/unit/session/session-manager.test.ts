import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import {
  createIntentClassifier,
  createSessionManager,
} from "../../../core/session/index.js";
import { initTestLogger } from "../../../core/logger/index.js";
import {
  makeInMemoryEpisodesRepo,
  makeInMemorySessionRepo,
} from "./_in-memory-repos.js";

describe("session/session-manager", () => {
  beforeAll(() => initTestLogger());

  let sessionsFake: ReturnType<typeof makeInMemorySessionRepo>;
  let episodesFake: ReturnType<typeof makeInMemoryEpisodesRepo>;
  let nowTick: number;

  beforeEach(() => {
    sessionsFake = makeInMemorySessionRepo();
    episodesFake = makeInMemoryEpisodesRepo();
    nowTick = 1_000;
  });

  function makeSm(opts: { idleCutoffMs?: number } = {}) {
    return createSessionManager({
      sessionsRepo: sessionsFake.repo,
      episodesRepo: episodesFake.repo,
      intentClassifier: createIntentClassifier({ disableLlm: true }),
      now: () => nowTick,
      idleCutoffMs: opts.idleCutoffMs,
    });
  }

  it("openSession inserts new row, subsequent open returns same id + startedAt", () => {
    const sm = makeSm();
    const s = sm.openSession({ agent: "openclaw", id: "se_fixed" });
    expect(s.id).toBe("se_fixed");
    expect(sessionsFake.rows.get("se_fixed")?.startedAt).toBe(1_000);
    nowTick = 2_000;
    const s2 = sm.openSession({ agent: "openclaw", id: "se_fixed" });
    expect(s2.id).toBe("se_fixed");
    // startedAt preserved (upsertIfMissing semantics)
    expect(s2.startedAt).toBe(1_000);
  });

  it("startEpisode runs intent classifier and emits events", async () => {
    const sm = makeSm();
    const session = sm.openSession({ agent: "openclaw" });
    const events: string[] = [];
    sm.bus.onAny((e) => events.push(e.kind));
    const ep = await sm.startEpisode({
      sessionId: session.id,
      userMessage: "/memos status",
    });
    expect(ep.intent.kind).toBe("meta");
    expect(ep.intent.retrieval).toEqual({ tier1: false, tier2: false, tier3: false });
    expect(events).toContain("episode.started");
  });

  it("startEpisode on unknown session throws SESSION_NOT_FOUND", async () => {
    const sm = makeSm();
    await expect(
      sm.startEpisode({ sessionId: "se_missing", userMessage: "hi" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_FOUND });
  });

  it("addTurn + finalizeEpisode updates counters and persists", async () => {
    const sm = makeSm();
    const session = sm.openSession({ agent: "openclaw" });
    const ep = await sm.startEpisode({
      sessionId: session.id,
      userMessage: "please fix this bug",
    });
    sm.addTurn(ep.id, { role: "assistant", content: "ok" });
    sm.addTurn(ep.id, { role: "tool", content: "stdout" });
    const closed = sm.finalizeEpisode(ep.id, { rTask: 0.5 });
    expect(closed.status).toBe("closed");
    expect(closed.rTask).toBe(0.5);
    expect(sm.getSession(session.id)?.openEpisodeCount).toBe(0);
  });

  it("attachTraceIds forwards to episode manager", async () => {
    const sm = makeSm();
    const session = sm.openSession({ agent: "openclaw" });
    const ep = await sm.startEpisode({ sessionId: session.id, userMessage: "go" });
    sm.attachTraceIds(ep.id, ["tr_1", "tr_2"]);
    expect(episodesFake.rows.get(ep.id)?.traceIds).toEqual(["tr_1", "tr_2"]);
  });

  it("pruneIdle evicts sessions with no open episodes past cutoff", async () => {
    const sm = makeSm({ idleCutoffMs: 1_000 });
    const a = sm.openSession({ agent: "openclaw", id: "se_idle" });
    const b = sm.openSession({ agent: "openclaw", id: "se_active" });
    // `a` never touched again; `b` has an open episode.
    nowTick = 1_050;
    await sm.startEpisode({ sessionId: b.id, userMessage: "hi there" });
    nowTick = 5_000;
    const pruned = sm.pruneIdle();
    expect(pruned).toEqual(["se_idle"]);
    expect(sm.getSession(a.id)).not.toBeNull(); // getSession reloads from repo
  });

  it("closeSession finalizes (not abandons) open episodes and emits session.closed", async () => {
    // V7 §0.2 — a user-initiated session close is normal lifecycle, not
    // episode abandonment. The episode is finalized so the reward
    // pipeline can score it; only truly trivial episodes get re-stamped
    // to "abandoned" by reward.ts itself with a clear reason.
    const sm = makeSm();
    const session = sm.openSession({ agent: "openclaw" });
    const ep = await sm.startEpisode({ sessionId: session.id, userMessage: "long running" });
    const events: string[] = [];
    sm.bus.onAny((e) => events.push(e.kind));
    sm.closeSession(session.id, "client");
    const stored = episodesFake.rows.get(ep.id);
    expect(stored?.status).toBe("closed");
    expect(stored?.meta.closeReason).toBe("finalized");
    // The literal session-end reason is preserved as audit metadata so
    // logs / analytics can still tell `/new` from `/quit` apart, but
    // it never reaches the user-facing `abandonReason` column.
    expect(stored?.meta.sessionCloseReason).toBe("client");
    expect(stored?.meta.abandonReason).toBeUndefined();
    expect(events).toContain("session.closed");
  });

  it("shutdown finalizes all open episodes across sessions", async () => {
    // V7 §0.2 — clean process shutdown is normal lifecycle (not a
    // crash), so episodes get `closeReason="finalized"` and the audit
    // trail goes into `meta.sessionCloseReason="shutdown:test"`.
    // Crash-orphans are handled separately on next bootstrap.
    const sm = makeSm();
    const s1 = sm.openSession({ agent: "openclaw" });
    const s2 = sm.openSession({ agent: "hermes" });
    await sm.startEpisode({ sessionId: s1.id, userMessage: "task one" });
    await sm.startEpisode({ sessionId: s2.id, userMessage: "task two" });
    sm.shutdown("test");
    for (const row of episodesFake.rows.values()) {
      expect(row.status).toBe("closed");
      expect(row.meta.closeReason).toBe("finalized");
      expect(row.meta.sessionCloseReason).toBe("shutdown:test");
      expect(row.meta.abandonReason).toBeUndefined();
    }
  });

  it("listEpisodes returns all episodes for a session", async () => {
    const sm = makeSm();
    const session = sm.openSession({ agent: "openclaw" });
    const ep1 = await sm.startEpisode({ sessionId: session.id, userMessage: "one" });
    const ep2 = await sm.startEpisode({ sessionId: session.id, userMessage: "two" });
    const list = sm.listEpisodes(session.id);
    expect(list.map((e) => e.id).sort()).toEqual([ep1.id, ep2.id].sort());
  });

  it("rejects empty userMessage with INVALID_ARGUMENT via initial turn guard", async () => {
    const sm = makeSm();
    const session = sm.openSession({ agent: "openclaw" });
    await expect(
      sm.startEpisode({ sessionId: session.id, userMessage: "" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_ARGUMENT });
  });

  it("the `bus` returned by the manager is the same bus episode events go through", async () => {
    const sm = makeSm();
    const session = sm.openSession({ agent: "openclaw" });
    const seen: string[] = [];
    sm.bus.on("episode.started", () => seen.push("ok"));
    await sm.startEpisode({ sessionId: session.id, userMessage: "do thing" });
    expect(seen).toEqual(["ok"]);
  });
});
