import { afterEach, describe, expect, it } from "vitest";

import { wrapRetrievalRepos } from "../../../core/pipeline/retrieval-repos.js";
import type {
  EmbeddingVector,
  EpisodeId,
  SessionId,
  TraceId,
  TraceRow,
} from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

function vector(values: number[]): EmbeddingVector {
  return Float32Array.from(values);
}

describe("pipeline/retrieval-repos", () => {
  let handle: TmpDbHandle | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("applies trace namespace visibility before channel Top-K", () => {
    handle = makeTmpDb({ agent: "openclaw" });
    const now = 1_700_000_000_000;

    for (const profileId of ["main", "other"]) {
      const sessionId = `session-${profileId}` as SessionId;
      const episodeId = `episode-${profileId}` as EpisodeId;
      handle.repos.sessions.upsert({
        id: sessionId,
        agent: "openclaw",
        ownerAgentKind: "openclaw",
        ownerProfileId: profileId,
        ownerWorkspaceId: null,
        startedAt: now,
        lastSeenAt: now,
        meta: {},
      });
      handle.repos.episodes.upsert({
        id: episodeId,
        sessionId,
        ownerAgentKind: "openclaw",
        ownerProfileId: profileId,
        ownerWorkspaceId: null,
        startedAt: now,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
      });
      handle.repos.traces.insert({
        id: `trace-${profileId}` as TraceId,
        episodeId,
        sessionId,
        ownerAgentKind: "openclaw",
        ownerProfileId: profileId,
        ownerWorkspaceId: null,
        ts: now,
        userText: `${profileId} fact`,
        agentText: "reply",
        summary: null,
        share: null,
        toolCalls: [],
        agentThinking: null,
        reflection: null,
        value: 0.8,
        alpha: 0.5,
        rHuman: null,
        priority: 0.8,
        tags: [],
        errorSignatures: [],
        vecSummary: profileId === "other" ? vector([1, 0]) : vector([0.9, 0.1]),
        vecAction: null,
        turnId: now,
        schemaVersion: 1,
      } as TraceRow);
    }

    const unwrapped = handle.repos.traces.searchByVector(vector([1, 0]), 1);
    expect(unwrapped[0]?.id).toBe("trace-other");

    const wrapped = wrapRetrievalRepos(handle.repos, {
      agentKind: "openclaw",
      profileId: "main",
    });
    const visible = wrapped.traces.searchByVector(vector([1, 0]), 1);
    expect(visible[0]?.id).toBe("trace-main");
  });
});
