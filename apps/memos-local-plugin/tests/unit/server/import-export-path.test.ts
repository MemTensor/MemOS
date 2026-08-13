import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveHermesNativeMemoryPath } from "../../../server/routes/import-export.js";

describe("Hermes native memory path", () => {
  it("uses HERMES_HOME before platform defaults", () => {
    const hermesHome = path.join(path.sep, "custom", "hermes-profile");

    expect(
      resolveHermesNativeMemoryPath({
        env: {
          HERMES_HOME: hermesHome,
          LOCALAPPDATA: path.join(path.sep, "local-app-data"),
        },
        platform: "win32",
        userHome: path.join(path.sep, "users", "alice"),
      }),
    ).toBe(path.join(hermesHome, "memories", "MEMORY.md"));
  });

  it("uses the Windows Hermes LocalAppData home by default", () => {
    const localAppData = path.join(path.sep, "users", "alice", "AppData", "Local");

    expect(
      resolveHermesNativeMemoryPath({
        env: { LOCALAPPDATA: localAppData },
        platform: "win32",
        userHome: path.join(path.sep, "users", "alice"),
      }),
    ).toBe(path.join(localAppData, "hermes", "memories", "MEMORY.md"));
  });

  it("keeps the Unix Hermes home fallback", () => {
    const userHome = path.join(path.sep, "home", "alice");

    expect(
      resolveHermesNativeMemoryPath({
        env: {},
        platform: "linux",
        userHome,
      }),
    ).toBe(path.join(userHome, ".hermes", "memories", "MEMORY.md"));
  });
});
