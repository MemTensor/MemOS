import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG, resolveHome } from "../../../core/config/index.js";
import { bootstrapMemoryCore } from "../../../core/pipeline/memory-core.js";
import { openDb } from "../../../core/storage/index.js";

let dir: string;
let core: MemoryCore;
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  episodeId: `episode-${id}`,
  sessionId: `session-${id}`,
  ts: 1_700_000_000_000,
  turnId: 1,
  userText: "Synthetic import test",
  agentText: "Synthetic answer",
  ...extra,
});

describe("bundle import validation and ownership", () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-import-test-"));
    core = await bootstrapMemoryCore({
      agent: "deepseek-harness",
      namespace: { agentKind: "deepseek-harness", profileId: "default" },
      home: resolveHome("deepseek-harness", dir),
      config: structuredClone(DEFAULT_CONFIG),
      autoRecovery: false,
    });
  });

  afterEach(async () => {
    await core?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("distinguishes invalid integer fields from duplicates without leaking row content", async () => {
    const valid = row("valid");
    const result = await core.importBundle({
      traces: [
        valid,
        row("fractional-ts", { ts: 12.5 }),
        row("fractional-turn", { turnId: 1.5 }),
        row("unsafe", { ts: Number.MAX_SAFE_INTEGER + 1 }),
        null,
        valid,
      ],
    });
    expect(result).toMatchObject({
      imported: 1,
      skipped: 5,
      duplicates: 1,
      invalid: 4,
      failed: 0,
      visible: 1,
      hidden: 0,
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trace",
          index: 1,
          field: "ts",
          code: "invalid_integer",
        }),
        expect.objectContaining({
          kind: "trace",
          index: 2,
          field: "turnId",
          code: "invalid_integer",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("Synthetic import test");
    expect((await core.exportBundle()).traces).toHaveLength(1);
  });

  it("reports database failures separately and rolls back synthetic parents", async () => {
    const db = openDb({
      filepath: resolveHome("deepseek-harness", dir).dbFile,
      agent: "deepseek-harness",
    });
    try {
      db.exec(
        "CREATE TRIGGER reject_import BEFORE INSERT ON traces BEGIN SELECT RAISE(ABORT, 'sensitive database detail'); END",
      );
      const result = await core.importBundle({ traces: [row("rejected")] });
      expect(result).toMatchObject({
        imported: 0,
        skipped: 1,
        failed: 1,
        invalid: 0,
        duplicates: 0,
      });
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "write_failed", index: 0 }),
      );
      expect(JSON.stringify(result)).not.toContain("sensitive database detail");
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM episodes").get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });

  it("previews visibility without writes and explicitly migrates private rows to a target profile", async () => {
    const seeded = row("seeded", {
      ownerAgentKind: "deepseek-harness",
      ownerProfileId: "seed",
    });
    const preview = await core.importBundle(
      { traces: [seeded] },
      { dryRun: true },
    );
    expect(preview).toMatchObject({
      imported: 1,
      visible: 0,
      hidden: 1,
      dryRun: true,
    });
    expect((await core.exportBundle()).traces).toHaveLength(0);
    const movedPreview = await core.importBundle(
      { traces: [seeded] },
      { dryRun: true, ownership: "target" },
    );
    expect(movedPreview).toMatchObject({ visible: 1, hidden: 0 });
    const result = await core.importBundle(
      { traces: [seeded] },
      { ownership: "target" },
    );
    expect(result).toMatchObject({ imported: 1, visible: 1, hidden: 0 });
    expect(await core.getTrace("seeded")).toMatchObject({
      ownerProfileId: "default",
      share: { scope: "private" },
    });
  });

  it("preserves original ownership by default and supports an explicit target profile", async () => {
    const seeded = row("preserved", {
      ownerAgentKind: "deepseek-harness",
      ownerProfileId: "seed",
    });
    expect(await core.importBundle({ traces: [seeded] })).toMatchObject({
      hidden: 1,
    });
    expect(await core.getTrace("preserved")).toBeNull();
    const result = await core.importBundle(
      { traces: [row("target")] },
      { ownership: "target", targetProfileId: "work" },
    );
    expect(result).toMatchObject({ hidden: 1 });
    expect(
      await core.getTrace("target", {
        agentKind: "deepseek-harness",
        profileId: "work",
      }),
    ).toMatchObject({ ownerProfileId: "work", share: { scope: "private" } });
  });

  it("bounds detailed issues while retaining accurate totals", async () => {
    const result = await core.importBundle({
      traces: Array.from({ length: 80 }, () => null),
    });
    expect(result).toMatchObject({ imported: 0, invalid: 80, skipped: 80 });
    expect(result.issues).toHaveLength(50);
  });

  it("rejects malformed top-level collections instead of silently importing nothing", async () => {
    await expect(
      core.importBundle({ traces: {} as never }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
