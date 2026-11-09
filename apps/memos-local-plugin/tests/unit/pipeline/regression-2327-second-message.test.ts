/**
 * Regression test for #2327 — memmy-agent "second message" session_not_found.
 *
 * Pattern: the host fires `session.close` (e.g. /new or an explicit session
 * end) and then immediately starts a new turn. Because of clock skew, a race,
 * or an eager `on_session_end`, `closeSession` can be called on an id the
 * orchestrator has already evicted from its live map. Previously that threw
 * `MemosError("session_not_found")` which surfaced to the user.  The fix makes
 * `closeSession` idempotent — unknown sessions are silently ignored — so the
 * subsequent `onTurnStart` or `openEpisode` can reopen the session normally.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentKind, SessionId } from "../../../agent-contract/dto.js";
import {
  createMemoryCore,
  createPipeline,
} from "../../../core/pipeline/index.js";
import { rootLogger } from "../../../core/logger/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

const AGENT: AgentKind = "openclaw";

let db: TmpDbHandle | null = null;

describe("memory-core / regression #2327: second-message session_not_found", () => {
  beforeEach(async () => {
    db = await makeTmpDb();
  });

  afterEach(async () => {
    if (db) {
      await db.cleanup();
      db = null;
    }
  });

  function buildCore() {
    const pipeline = createPipeline({
      agent: AGENT,
      home: resolveHome(AGENT, "/tmp/memos-mc-test"),
      config: DEFAULT_CONFIG,
      db: db!.db,
      repos: db!.repos,
      llm: null,
      reflectLlm: null,
      embedder: fakeEmbedder({ dimensions: 384 }),
      log: rootLogger.child({ channel: "test.regress-2327" }),
      namespace: { agentKind: AGENT, profileId: "main" },
      now: () => Date.now(),
    });
    return createMemoryCore(
      pipeline,
      resolveHome(AGENT, "/tmp/memos-mc-test"),
      "test",
    );
  }

  it("closeSession on an already-closed session does NOT throw (idempotent)", async () => {
    const core = buildCore();
    await core.init();

    const sid = await core.openSession({ agent: AGENT, sessionId: "se_regress_2327" as SessionId });

    const ep = await core.openEpisode({ sessionId: sid, userMessage: "first message" });
    await core.closeEpisode(ep);
    await core.closeSession(sid);

    // Second call — session no longer in the live map; must not throw.
    await expect(core.closeSession(sid)).resolves.toBeUndefined();

    await core.shutdown();
  });

  it("openEpisode succeeds on second message after closeSession was called (fix for #2327)", async () => {
    const core = buildCore();
    await core.init();

    const sid = await core.openSession({ agent: AGENT, sessionId: "se_regress_2327" as SessionId });

    // First message — normal path.
    const ep1 = await core.openEpisode({ sessionId: sid, userMessage: "first message" });
    await core.closeEpisode(ep1);

    // Host fires session.close (e.g. /new command or adapter lifecycle).
    await core.closeSession(sid);

    // Second message arrives.  Adapter re-opens the session first (normal
    // path) — this must succeed even though closeSession already ran.
    const sid2 = await core.openSession({ agent: AGENT, sessionId: sid });
    expect(sid2).toBe(sid);

    const ep2 = await core.openEpisode({ sessionId: sid, userMessage: "second message" });
    expect(ep2).toBeTruthy();
    expect(ep2).not.toBe(ep1);

    await core.shutdown();
  });

  it("openEpisode succeeds even when adapter skips re-openSession after close (defensive path)", async () => {
    // Some adapter implementations (or races) may call openEpisode without an
    // intervening openSession.  ensureSession inside the orchestrator handles
    // this by reopening from the DB row; the bug was that closeSession threw
    // before this path was reached, making the second turn fatal.
    const core = buildCore();
    await core.init();

    const sid = await core.openSession({ agent: AGENT, sessionId: "se_regress_2327b" as SessionId });

    const ep1 = await core.openEpisode({ sessionId: sid, userMessage: "first" });
    await core.closeEpisode(ep1);
    await core.closeSession(sid);

    // Deliberately skip openSession — openEpisode must still succeed because
    // onTurnStart / startEpisode re-opens via ensureSession internally.
    const ep2 = await core.openEpisode({ sessionId: sid, userMessage: "second" });
    expect(ep2).toBeTruthy();

    await core.shutdown();
  });

  it("onTurnStart on a closed session does NOT throw (ensureSession reopens)", async () => {
    const core = buildCore();
    await core.init();

    const sid = await core.openSession({ agent: AGENT, sessionId: "se_regress_2327c" as SessionId });

    // First turn — normal.
    const first = await core.onTurnStart({
      agent: AGENT,
      sessionId: sid,
      userText: "first message",
      ts: Date.now(),
    });
    expect(first.query.sessionId).toBe(sid);

    await core.onTurnEnd({
      agent: AGENT,
      sessionId: first.query.sessionId ?? sid,
      episodeId: first.query.episodeId!,
      agentText: "ok",
      toolCalls: [],
      ts: Date.now(),
    });
    await core.closeSession(sid);

    // Second turn — ensureSession must reopen; must not throw.
    const second = await core.onTurnStart({
      agent: AGENT,
      sessionId: sid,
      userText: "second message",
      ts: Date.now(),
    });
    expect(second.query.sessionId).toBe(sid);

    await core.shutdown();
  });
});
