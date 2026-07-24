import path from "node:path";

import { describe, expect, it } from "vitest";

import { openClawRuntimeSocketPath } from "../../../adapters/openclaw/runtime-paths.js";
import type { ResolvedHome } from "../../../core/config/index.js";

function home(root: string): ResolvedHome {
  return {
    root,
    configFile: path.join(root, "config.yaml"),
    dataDir: path.join(root, "data"),
    dbFile: path.join(root, "data", "memos.db"),
    skillsDir: path.join(root, "skills"),
    logsDir: path.join(root, "logs"),
    daemonDir: path.join(root, "daemon"),
  };
}

describe("OpenClaw shared runtime endpoint", () => {
  it("keeps Unix socket paths below sockaddr_un limits", () => {
    const nested = `/tmp/${"very-long-evaluation-home/".repeat(12)}`;
    const endpoint = openClawRuntimeSocketPath(home(nested), "linux");
    expect(endpoint.endsWith(".sock")).toBe(true);
    expect(endpoint.length).toBeLessThan(100);
  });

  it("uses a Windows named pipe instead of a Unix socket", () => {
    const endpoint = openClawRuntimeSocketPath(
      home("C:\\Users\\tester\\memos-plugin"),
      "win32",
    );
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\memos-openclaw-/);
    expect(endpoint.endsWith(".sock")).toBe(false);
  });

  it("isolates different MEMOS_HOME values", () => {
    expect(openClawRuntimeSocketPath(home("/tmp/a"), "linux")).not.toBe(
      openClawRuntimeSocketPath(home("/tmp/b"), "linux"),
    );
  });
});
