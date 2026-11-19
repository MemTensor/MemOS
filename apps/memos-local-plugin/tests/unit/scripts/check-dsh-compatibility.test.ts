import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const manifest = {
  devDependencies: {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-agent": "0.2.1-rc.3",
    "@deepseek-ai/dsh-session-format-v3-to-v4": "0.2.1-rc.3",
  },
  peerDependencies: { "@deepseek-ai/cordis": "^4.0.1" },
};
let writtenManifest: { devDependencies: Record<string, string> } | undefined;
let hostCordis: string | undefined;
const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  writtenManifest = undefined;
  hostCordis = "~4.1.0";
  manifest.peerDependencies["@deepseek-ai/cordis"] = "^4.0.1";
  process.argv = [process.execPath, "check-dsh-compatibility.mjs", "0.2.2-rc.5"];
  vi.doMock("node:fs/promises", () => ({
    readFile: vi.fn(async () => JSON.stringify(manifest)),
    mkdtemp: vi.fn(async () => "/tmp/memos-matrix-test"),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    symlink: vi.fn(async () => {}),
    cp: vi.fn(async () => {}),
    writeFile: vi.fn(async (_path: string, data: string) => {
      writtenManifest = JSON.parse(data);
    }),
  }));
  vi.doMock("node:child_process", () => ({
    spawnSync: vi.fn(() => ({ status: 0 })),
  }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({
      name: decodeURIComponent(new URL(url).pathname.slice(1)).replace(/\/0\.2\.2-rc\.5$/, ""),
      peerDependencies: hostCordis ? { "@deepseek-ai/cordis": hostCordis } : undefined,
    }),
  })));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:child_process");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("DSH compatibility fixture dependency selection", () => {
  it("pins rc.5 Cordis and the matching session codec", async () => {
    await import("../../../scripts/check-dsh-compatibility.mjs");
    expect(writtenManifest?.devDependencies).toMatchObject({
      "@deepseek-ai/cordis": "4.1.0",
      "@deepseek-ai/dsh-agent": "0.2.2-rc.5",
      "@deepseek-ai/dsh-session-format-v3-to-v4": "0.2.2-rc.5",
    });
  });

  it("handles metadata without optional peer dependencies", async () => {
    hostCordis = undefined;
    await import("../../../scripts/check-dsh-compatibility.mjs");
    expect(writtenManifest?.devDependencies["@deepseek-ai/cordis"]).toBe("4.1.0");
  });

  it("rejects a Cordis version outside the host service peer range", async () => {
    hostCordis = "^5.0.0";
    await expect(import("../../../scripts/check-dsh-compatibility.mjs"))
      .rejects.toThrow("does not satisfy @deepseek-ai/dsh-agent@0.2.2-rc.5 peer ^5.0.0");
    expect(writtenManifest).toBeUndefined();
  });

  it("rejects a Cordis version outside the plugin peer range", async () => {
    manifest.peerDependencies["@deepseek-ai/cordis"] = "^5.0.0";
    await expect(import("../../../scripts/check-dsh-compatibility.mjs"))
      .rejects.toThrow("does not satisfy plugin peer ^5.0.0");
    expect(writtenManifest).toBeUndefined();
  });
});
