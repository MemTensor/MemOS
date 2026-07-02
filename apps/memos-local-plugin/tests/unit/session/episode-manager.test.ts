import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import {
  createEpisodeManager,
  createSessionEventBus,
  retrievalFor,
} from "../../../core/session/index.js";
import { initTestLogger } from "../../../core/logger/index.js";
import type { IntentDecision } from "../../../core/session/types.js";
import {
  makeInMemoryEpisodesRepo,
  makeInMemorySessionRepo,
} from "./_in-memory-repos.js";

function intent(kind: IntentDecision["kind"] = "task"): IntentDecision {
  return {
    kind,
    confidence: 0.9,
    reason: "test",
    retrieval: retrievalFor(kind),
    signals: ["test"],
  };
}

describe("session/episode-manager", () => {
  beforeAll(() => initTestLogger());

  let sessionsFake: ReturnType<typeof makeInMemorySessionRepo>;
  let episodesFake: ReturnType<typeof makeInMemoryEpisodesRepo>;
  let nowTick: number;

  beforeEach(() => {
    sessionsFake = makeInMemorySessionRepo();
    episodesFake = makeInMemoryEpisodesRepo();
    nowTick = 1_000;
    sessionsFake.repo.upsertIfMissing({
      id: "se_a",
      agent: "openclaw",
      startedAt: 1_000,
      lastSeenAt: 1_000,
      meta: {},
    });
  });

  function makeEpm() {
    const bus = createSessionEventBus();
    const epm = createEpisodeManager({
      sessionsRepo: sessionsFake.repo,
      episodesRepo: episodesFake.repo,
      now: () => nowTick,
      bus,
    });
    return { epm, bus };
  }

  it("start inserts row and emits episode.started", () => {
    const { epm, bus } = makeEpm();
    const events: string[] = [];
    bus.onAny((e) => events.push(e.kind));
    const snap = epm.start(
      {
        sessionId: "se_a",
        initialTurn: { role: "user", content: "hi" },
        meta: { source: "test" },
      },
      intent("task"),
    );
    expect(snap.status).toBe("open");
    expect(snap.turnCount).toBe(1);
    expect(snap.turns[0]?.role).toBe("user");
    expect(snap.intent.kind).toBe("task");
    expect(episodesFake.rows.get(snap.id)?.status).toBe("open");
    expect(events).toEqual(["episode.started"]);
  });

  it("rejects empty initial turn", () => {
    const { epm } = makeEpm();
    try {
      epm.start(
        { sessionId: "se_a", initialTurn: { role: "user", content: "" } },
        intent(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe(ERROR_CODES.INVALID_ARGUMENT);
    }
  });

  it("addTurn appends and emits episode.turn_added", () => {
    const { epm, bus } = makeEpm();
    const events: string[] = [];
    bus.onAny((e) => events.push(e.kind));
    const snap = epm.start(
      { sessionId: "se_a", initialTurn: { role: "user", content: "do it" } },
      intent(),
    );
    nowTick = 2_000;
    const turn = epm.addTurn(snap.id, { role: "assistant", content: "done" });
    expect(turn.role).toBe("assistant");
    expect(turn.ts).toBe(2_000);
    expect(epm.get(snap.id)?.turnCount).toBe(2);
    expect(events.filter((e) => e === "episode.turn_added")).toHaveLength(1);
  });

  it("finalize closes row, emits finalized with closedBy=finalized", () => {
    const { epm, bus } = makeEpm();
    const events: Array<{ kind: string; closedBy?: string }> = [];
    bus.onAny((e) => {
      if (e.kind === "episode.finalized") events.push({ kind: e.kind, closedBy: e.closedBy });
      else events.push({ kind: e.kind });
    });
    const snap = epm.start(
      { sessionId: "se_a", initialTurn: { role: "user", content: "x" } },
      intent(),
    );
    nowTick = 3_000;
    const closed = epm.finalize(snap.id, { rTask: 0.7 });
    expect(closed.status).toBe("closed");
    expect(closed.endedAt).toBe(3_000);
    expect(closed.rTask).toBe(0.7);
    const db = episodesFake.rows.get(snap.id)!;
    expect(db.status).toBe("closed");
    expect(db.rTask).toBe(0.7);
    expect(db.meta.closeReason).toBe("finalized");
    const finalEvt = events.find((e) => e.kind === "episode.finalized");
    expect(finalEvt?.closedBy).toBe("finalized");
  });

  it("addTurn on closed episode throws CONFLICT", () => {
    const { epm } = makeEpm();
    const snap = epm.start(
      { sessionId: "se_a", initialTurn: { role: "user", content: "x" } },
      intent(),
    );
    epm.finalize(snap.id);
    try {
      epm.addTurn(snap.id, { role: "assistant", content: "late" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe(ERROR_CODES.CONFLICT);
    }
  });

  it("abandon closes + emits finalized(abandoned) + episode.abandoned", () => {
    const { epm, bus } = makeEpm();
    const events: string[] = [];
    const closedBy: string[] = [];
    bus.onAny((e) => {
      events.push(e.kind);
      if (e.kind === "episode.finalized") closedBy.push(e.closedBy);
    });
    const snap = epm.start(
      { sessionId: "se_a", initialTurn: { role: "user", content: "x" } },
      intent(),
    );
    epm.abandon(snap.id, "host_crashed");
    expect(episodesFake.rows.get(snap.id)?.meta.closeReason).toBe("abandoned");
    expect(closedBy).toEqual(["abandoned"]);
    expect(events).toContain("episode.abandoned");
  });

  it("attachTraceIds updates snapshot and DB row", () => {
    const { epm } = makeEpm();
    const snap = epm.start(
      { sessionId: "se_a", initialTurn: { role: "user", content: "x" } },
      intent(),
    );
    epm.attachTraceIds(snap.id, ["tr_a", "tr_b"]);
    expect(episodesFake.rows.get(snap.id)?.traceIds).toEqual(["tr_a", "tr_b"]);
    epm.attachTraceIds(snap.id, ["tr_c"]);
    expect(episodesFake.rows.get(snap.id)?.traceIds).toEqual(["tr_a", "tr_b", "tr_c"]);
  });

  it("attachTraceIds on missing episode throws EPISODE_NOT_FOUND", () => {
    const { epm } = makeEpm();
    try {
      epm.attachTraceIds("ep_missing", ["tr_x"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as MemosError).code).toBe(ERROR_CODES.EPISODE_NOT_FOUND);
    }
  });

  it("listOpen and listForSession filter correctly", () => {
    const { epm } = makeEpm();
    const s1 = epm.start(
      { sessionId: "se_a", initialTurn: { role: "user", content: "q1" } },
      intent(),
    );
    const s2 = epm.start(
      { sessionId: "se_a", initialTurn: { role: "user", content: "q2" } },
      intent(),
    );
    epm.finalize(s2.id);
    const open = epm.listOpen();
    expect(open.map((e) => e.id)).toEqual([s1.id]);
    const all = epm.listForSession("se_a");
    expect(all.map((e) => e.id).sort()).toEqual([s1.id, s2.id].sort());
  });
});
