import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildContext, getOpenClawConfigPath, getOpenClawHome } from "../src/config";
import { loadOpenClawFallbackConfig as loadProviderFallbackConfig } from "../src/ingest/providers";
import { loadOpenClawFallbackConfig as loadSharedFallbackConfig, buildSkillConfigChain } from "../src/shared/llm-call";
import { ViewerServer } from "../src/viewer/server";

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function writeOpenClawConfig(stateDir: string, model: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: `openai/${model}`,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.com/v1",
            apiKey: "test-key",
          },
        },
      },
    }),
    "utf-8",
  );
}

describe("profile-aware OpenClaw paths", () => {
  let tmpDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let profileStateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-profile-paths-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;

    writeOpenClawConfig(path.join(tmpDir, ".openclaw"), "default-model");
    profileStateDir = path.join(tmpDir, ".openclaw-lucky");
    writeOpenClawConfig(profileStateDir, "profile-model");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers provided stateDir over the default ~/.openclaw paths", () => {
    expect(getOpenClawHome()).toBe(path.join(tmpDir, ".openclaw"));
    expect(getOpenClawConfigPath()).toBe(path.join(tmpDir, ".openclaw", "openclaw.json"));
    expect(getOpenClawHome(profileStateDir)).toBe(profileStateDir);
    expect(getOpenClawConfigPath(profileStateDir)).toBe(path.join(profileStateDir, "openclaw.json"));
  });

  it("loads fallback model config from the active profile stateDir", () => {
    const defaultCfg = loadProviderFallbackConfig(noopLog as any);
    const profileCfg = loadProviderFallbackConfig(noopLog as any, profileStateDir);
    const sharedCfg = loadSharedFallbackConfig(noopLog as any, profileStateDir);

    expect(defaultCfg?.model).toBe("default-model");
    expect(profileCfg?.model).toBe("profile-model");
    expect(sharedCfg?.model).toBe("profile-model");
  });

  it("uses the profile stateDir in the skill chain and viewer helpers", () => {
    const ctx = buildContext(profileStateDir, path.join(tmpDir, "workspace"), {}, noopLog as any);
    const chain = buildSkillConfigChain(ctx);
    const viewer = new ViewerServer({
      store: {} as any,
      embedder: {} as any,
      port: 0,
      log: noopLog as any,
      dataDir: profileStateDir,
      ctx,
    });

    expect(chain).toHaveLength(1);
    expect(chain[0]?.model).toBe("profile-model");
    expect((viewer as any).getOpenClawHome()).toBe(profileStateDir);
    expect((viewer as any).getOpenClawConfigPath()).toBe(path.join(profileStateDir, "openclaw.json"));
  });
});
