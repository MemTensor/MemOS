import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceDTO } from "../../../agent-contract/dto.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { registerImportExportRoutes } from "../../../server/routes/import-export.js";
import { Routes, type RouteContext } from "../../../server/routes/registry.js";

describe("Hermes native memory import", () => {
  let hermesHome: string;
  let memoryPath: string;
  let userPath: string;
  let routes: Routes;
  const importBundle = vi.fn(async (bundle: Parameters<MemoryCore["importBundle"]>[0]) => ({
    imported: bundle.traces?.length ?? 0,
    skipped: 0,
  }));

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(join(tmpdir(), "memos-hermes-import-"));
    const memoriesDir = join(hermesHome, "memories");
    fs.mkdirSync(memoriesDir);
    memoryPath = join(memoriesDir, "MEMORY.md");
    userPath = join(memoriesDir, "USER.md");
    vi.stubEnv("HERMES_HOME", hermesHome);
    importBundle.mockClear();
    routes = new Routes();
    registerImportExportRoutes(routes, { core: { importBundle } as unknown as MemoryCore }, {
      agent: "hermes",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(hermesHome, { recursive: true, force: true });
  });

  function context(body: unknown = {}): RouteContext {
    return {
      body: Buffer.from(JSON.stringify(body)),
      res: { writeHead: vi.fn(), end: vi.fn() },
    } as unknown as RouteContext;
  }

  async function scan() {
    return await routes.getExact("GET /api/v1/import/hermes-native/scan")!(context());
  }

  async function run(offset = 0, limit = 25) {
    return await routes.getExact("POST /api/v1/import/hermes-native/run")!(
      context({ offset, limit }),
    );
  }

  function lastTraces(): TraceDTO[] {
    return importBundle.mock.calls.at(-1)![0].traces as TraceDTO[];
  }

  it("scans and pages through both files with source tags and each file's timestamp", async () => {
    const memoryText = "first memory\n§\nshared fact\n";
    const userText = "preferred language: 中文\r\n§\r\nshared fact\r\n§\r\n";
    fs.writeFileSync(memoryPath, memoryText);
    fs.writeFileSync(userPath, userText);
    const memoryTime = new Date("2026-01-02T00:00:00Z");
    const userTime = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(memoryPath, memoryTime, memoryTime);
    fs.utimesSync(userPath, userTime, userTime);

    expect(await scan()).toMatchObject({
      found: true,
      total: 4,
      path: memoryPath,
      bytes: Buffer.byteLength(memoryText) + Buffer.byteLength(userText),
    });
    expect(await run(0, 3)).toMatchObject({
      total: 4, nextOffset: 3, imported: 3, done: false,
    });
    const firstPage = lastTraces();
    expect(firstPage).toMatchObject([
      { userText: "first memory", summary: "first memory", tags: ["MEMORY.md"] },
      { userText: "shared fact", summary: "shared fact", tags: ["MEMORY.md"] },
      {
        userText: "preferred language: 中文",
        summary: "preferred language: 中文",
        tags: ["USER.md"],
      },
    ]);
    expect(firstPage[0].ts).toBeGreaterThan(memoryTime.getTime() - 10_000);
    expect(firstPage[0].ts).toBeLessThanOrEqual(memoryTime.getTime());
    expect(firstPage[2].ts).toBeGreaterThan(userTime.getTime() - 10_000);
    expect(firstPage[2].ts).toBeLessThanOrEqual(userTime.getTime());

    expect(await run(3, 3)).toMatchObject({
      total: 4, nextOffset: 4, imported: 1, done: true,
    });
    const lastPage = lastTraces();
    expect(lastPage).toMatchObject([
      { userText: "shared fact", summary: "shared fact", tags: ["USER.md"] },
    ]);
    expect(lastPage[0].id).not.toBe(firstPage[1].id);

    expect(await run(4, 3)).toMatchObject({
      total: 4, nextOffset: 4, imported: 0, skipped: 0, done: true,
    });
    expect(importBundle).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", " \r\n§\r\n\r\n"])(
    "keeps MEMORY.md imports working with missing or empty USER.md (%j)",
    async (userText) => {
      const memoryText = "first memory\n§\nsecond memory";
      fs.writeFileSync(memoryPath, memoryText);
      if (userText !== undefined) fs.writeFileSync(userPath, userText);

      expect(await scan()).toMatchObject({
        found: true,
        total: 2,
        bytes: Buffer.byteLength(memoryText) + Buffer.byteLength(userText ?? ""),
      });
      expect(await run()).toMatchObject({ total: 2, imported: 2, done: true });
      expect(lastTraces().map((trace) => trace.userText)).toEqual([
        "first memory", "second memory",
      ]);
    },
  );

  it("preserves legacy MEMORY.md IDs and keeps USER.md IDs stable when MEMORY.md grows", async () => {
    fs.writeFileSync(memoryPath, "shared fact");
    fs.writeFileSync(userPath, "shared fact");
    expect(await run(0, 1)).toMatchObject({ total: 2, imported: 1, done: false });
    const originalMemory = lastTraces()[0];
    // Existing imports use this identity; changing it would duplicate their rows.
    const legacyHash = createHash("sha256").update("0\0shared fact").digest("hex").slice(0, 24);
    expect(originalMemory).toMatchObject({
      id: `tr_hm_${legacyHash}`,
      episodeId: `ep_hm_${legacyHash}`,
      sessionId: "se_hermes_native_memory",
    });
    await run(1, 1);
    const originalUser = lastTraces()[0];
    expect(originalUser.id).not.toBe(originalMemory.id);

    fs.appendFileSync(memoryPath, "\n§\nanother memory");
    expect(await run()).toMatchObject({ total: 3, imported: 3, done: true });
    expect(lastTraces()[0].id).toBe(originalMemory.id);
    expect(lastTraces()[2]).toMatchObject({
      id: originalUser.id,
      episodeId: originalUser.episodeId,
      userText: "shared fact",
      tags: ["USER.md"],
    });
  });

  it.each(["MEMORY.md", "USER.md"])(
    "refreshes a cached page after a same-size edit to the older %s",
    async (file) => {
      fs.writeFileSync(memoryPath, "first memory\n§\nsecond memory");
      fs.writeFileSync(userPath, "first profile");
      const editedPath = file === "MEMORY.md" ? memoryPath : userPath;
      const newerPath = file === "MEMORY.md" ? userPath : memoryPath;
      const oldTime = new Date("2026-01-01T00:00:00Z");
      const changedTime = new Date("2026-01-02T00:00:00Z");
      const newerTime = new Date("2026-01-03T00:00:00Z");
      fs.utimesSync(editedPath, oldTime, oldTime);
      fs.utimesSync(newerPath, newerTime, newerTime);
      await run();

      const previousSize = fs.statSync(editedPath).size;
      const changedText = file === "MEMORY.md"
        ? "first memory\n§\nlatest memory"
        : "other profile";
      fs.writeFileSync(editedPath, changedText);
      fs.utimesSync(editedPath, changedTime, changedTime);
      expect(fs.statSync(editedPath).size).toBe(previousSize);

      expect(await run(1)).toMatchObject({ total: 3, imported: 2, done: true });
      expect(lastTraces().map((trace) => trace.userText)).toEqual(
        file === "MEMORY.md"
          ? ["latest memory", "first profile"]
          : ["second memory", "other profile"],
      );
    },
  );

  it("refreshes cached pages when USER.md appears or disappears", async () => {
    fs.writeFileSync(memoryPath, "first memory\n§\nsecond memory");
    await run();

    fs.writeFileSync(userPath, "new profile");
    expect(await run(2)).toMatchObject({ total: 3, imported: 1, done: true });
    expect(lastTraces()[0].userText).toBe("new profile");

    fs.unlinkSync(userPath);
    expect(await run(1)).toMatchObject({ total: 2, imported: 1, done: true });
    expect(lastTraces().map((trace) => trace.userText)).toEqual(["second memory"]);
  });

  it("reports USER.md read errors instead of silently dropping profile entries", async () => {
    fs.writeFileSync(memoryPath, "first memory");
    fs.mkdirSync(userPath);

    expect(await scan()).toMatchObject({ found: false, total: 0, error: expect.any(String) });
    const ctx = context({ offset: 0 });
    await routes.getExact("POST /api/v1/import/hermes-native/run")!(ctx);
    expect(ctx.res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(importBundle).not.toHaveBeenCalled();
  });
});
