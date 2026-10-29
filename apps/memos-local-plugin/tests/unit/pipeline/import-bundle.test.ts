import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG, resolveHome } from "../../../core/config/index.js";
import { bootstrapMemoryCore } from "../../../core/pipeline/memory-core.js";
import { openDb } from "../../../core/storage/index.js";
import { deepSeekHarnessNamespace } from "../../../adapters/deepseek-harness/namespace.js";

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

  it("round-trips world model structure and evidence without losing legacy string entries", async () => {
    const structure = {
      environment: [
        {
          label: "cloud",
          description: "synthetic cloud",
          evidenceIds: ["trace-evidence"],
        },
      ],
      inference: [{ label: "region", description: "synthetic-region" }],
      constraints: [
        {
          label: "boundary",
          description: "synthetic constraint",
          evidenceIds: [],
        },
      ],
    };
    await core.importBundle({
      worldModels: [
        {
          id: "world-source",
          title: "Synthetic",
          body: "Synthetic body",
          structure,
          version: 3,
          status: "active",
        },
      ],
    });
    const exported = (await core.exportBundle()).worldModels[0]!;
    expect(exported.structure).toEqual(structure);
    await core.importBundle({
      worldModels: [{ ...exported, id: "world-copy" }],
    });
    expect(
      (await core.exportBundle()).worldModels.find(
        (row) => row.id === "world-copy",
      ),
    ).toMatchObject({ structure, version: 3 });
    const legacy = {
      environment: ["aws"],
      inference: ["region=synthetic"],
      constraints: ["synthetic-limit"],
    };
    await core.importBundle({
      worldModels: [
        {
          id: "world-legacy",
          title: "Legacy",
          body: "Synthetic body",
          structure: legacy,
        },
      ],
    });
    expect(
      (await core.exportBundle()).worldModels.find(
        (row) => row.id === "world-legacy",
      )!.structure,
    ).toEqual(legacy);
  });

  it.each([[], { environment: "not-an-array" }, { constraints: [123] }])(
    "rejects malformed world model structure in preview and actual import: %j",
    async (structure) => {
      for (const dryRun of [true, false]) {
        const result = await core.importBundle(
          {
            worldModels: [
              {
                id: "invalid-structure",
                title: "Synthetic",
                body: "Synthetic body",
                structure,
              },
            ],
          },
          { dryRun },
        );
        expect(result).toMatchObject({ imported: 0, invalid: 1, failed: 0 });
        expect(result.issues[0]).toMatchObject({
          code: "invalid_field",
          field: expect.stringContaining("structure"),
        });
      }
    },
  );

  it("rejects an existing episode's conflicting session in preview and write without synthetic parents", async () => {
    const parent = row("parent");
    await core.importBundle({ traces: [parent] });
    const conflict = row("conflict", { episodeId: parent.episodeId });
    for (const dryRun of [true, false]) {
      const result = await core.importBundle(
        { traces: [conflict] },
        { dryRun },
      );
      expect(result).toMatchObject({
        imported: 0,
        invalid: 1,
        failed: 0,
        skipped: 1,
      });
      expect(result.issues[0]).toMatchObject({
        code: "conflicting_parent",
        field: "sessionId",
      });
    }
    const db = openDb({
      filepath: resolveHome("deepseek-harness", dir).dbFile,
      agent: "deepseek-harness",
    });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({
        n: 1,
      });
      expect(db.prepare("SELECT trace_ids_json FROM episodes").get()).toEqual({
        trace_ids_json: JSON.stringify([parent.id]),
      });
    } finally {
      db.close();
    }
  });

  it("detects parent conflicts created earlier in the bundle, including across preview batches", async () => {
    const parent = row("batch-parent");
    const traces = [
      parent,
      ...Array.from({ length: 100 }, (_, i) => row(`independent-${i}`)),
      row("batch-conflict", { episodeId: parent.episodeId }),
    ];
    for (const dryRun of [true, false]) {
      const result = await core.importBundle({ traces }, { dryRun });
      expect(result).toMatchObject({ imported: 101, invalid: 1, failed: 0 });
      expect(result.issues[0]).toMatchObject({
        index: 101,
        code: "conflicting_parent",
      });
      if (dryRun) expect((await core.exportBundle()).traces).toHaveLength(0);
    }
  });

  it("refuses to attach rows to another profile's session or episode", async () => {
    const parent = row("foreign-parent", {
      ownerAgentKind: "deepseek-harness",
      ownerProfileId: "foreign",
    });
    await core.importBundle({ traces: [parent] });
    for (const dryRun of [true, false]) {
      const result = await core.importBundle(
        {
          traces: [
            row("foreign-session", { sessionId: parent.sessionId }),
            row("foreign-episode", {
              sessionId: parent.sessionId,
              episodeId: parent.episodeId,
            }),
          ],
        },
        { dryRun },
      );
      expect(result).toMatchObject({ imported: 0, invalid: 2, failed: 0 });
      expect(
        result.issues.every((issue) => issue.code === "conflicting_parent"),
      ).toBe(true);
    }
  });

  it("makes UI presets and headless share configured-profile records without exposing other profiles", async () => {
    const ui = deepSeekHarnessNamespace(
      { id: "ui", header: { agentPreset: "standard" } },
      "default",
    );
    const headless = deepSeekHarnessNamespace({ id: "headless" }, "default");
    await core.importBundle({
      traces: [
        row("ui-memory", {
          ownerAgentKind: ui.agentKind,
          ownerProfileId: ui.profileId,
        }),
      ],
    });
    expect(await core.getTrace("ui-memory", headless)).not.toBeNull();
    expect(
      await core.getTrace(
        "ui-memory",
        deepSeekHarnessNamespace(
          { id: "other", header: { agentPreset: "standard" } },
          "work",
        ),
      ),
    ).toBeNull();
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
