/**
 * End-to-end: open → migrate → multi-repo write → cross-repo read → close.
 * A sanity net for the "realistic" flow Phase 15 will orchestrate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeRepos, openDb, runMigrations } from "../../../core/storage/index.js";

function vec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

describe("storage/end-to-end", () => {
  it("simulates one happy-path turn across sessions/episodes/traces/policies/skills", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-e2e-"));
    const filepath = path.join(dir, "memos.db");
    try {
      const db = openDb({ filepath, agent: "openclaw" });
      runMigrations(db);
      const repos = makeRepos(db);

      db.tx(() => {
        repos.sessions.upsert({
          id: "s-1",
          agent: "openclaw",
          startedAt: 100,
          lastSeenAt: 100,
          meta: { host: "test" },
        });
        repos.episodes.insert({
          id: "e-1",
          sessionId: "s-1",
          startedAt: 100,
          endedAt: null,
          traceIds: [],
          rTask: null,
          status: "open",
        });
        repos.traces.insert({
          id: "t-1",
          episodeId: "e-1",
          sessionId: "s-1",
          ts: 101,
          userText: "list skills",
          agentText: "done",
          toolCalls: [{ name: "memory_search", input: {}, startedAt: 101, endedAt: 102 }],
          reflection: "quick",
          value: 0.2,
          alpha: 0.5,
          rHuman: null,
          priority: 0.25,
          tags: ["memory"],
          vecSummary: vec([1, 0, 0]),
          vecAction: null,
          schemaVersion: 1,
        });
        repos.episodes.appendTrace("e-1", ["t-1"]);
        repos.policies.upsert({
          id: "p-1",
          title: "answer-quickly",
          trigger: "simple q",
          procedure: "short answer",
          verification: "user stops asking",
          boundary: "",
          support: 1,
          gain: 0.2,
          status: "candidate",
          sourceEpisodeIds: ["e-1"],
          inducedBy: "l2.incremental",
          vec: vec([1, 0, 0]),
          createdAt: 101,
          updatedAt: 101,
        });
        repos.skills.insert({
          id: "sk-1",
          name: "answer-quickly",
          status: "candidate",
          invocationGuide: "give direct answers",
          procedureJson: null,
          eta: 0,
          support: 1,
          gain: 0.2,
          trialsAttempted: 0,
          trialsPassed: 0,
          sourcePolicyIds: ["p-1"],
          sourceWorldModelIds: [],
          vec: vec([1, 0, 0]),
          createdAt: 101,
          updatedAt: 101,
        });
        repos.feedback.insert({
          id: "fb-1",
          ts: 110,
          episodeId: "e-1",
          traceId: "t-1",
          channel: "explicit",
          polarity: "positive",
          magnitude: 0.8,
          rationale: "good",
          raw: null,
        });
      });

      // Read back and verify cross-table consistency.
      const episode = repos.episodes.getById("e-1")!;
      expect(episode.traceIds).toEqual(["t-1"]);

      const topTraces = repos.traces.searchByVector(vec([1, 0, 0]), 5);
      expect(topTraces[0]!.id).toBe("t-1");

      const topSkills = repos.skills.searchByVector(vec([1, 0, 0]), 5);
      expect(topSkills[0]!.id).toBe("sk-1");

      const feedback = repos.feedback.getForTrace("t-1");
      expect(feedback[0]!.polarity).toBe("positive");

      const migs = repos.migrations.listApplied();
      expect(migs.length).toBeGreaterThan(0);
      expect(repos.migrations.highestAppliedVersion()).toBe(migs[migs.length - 1]!.version);

      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
