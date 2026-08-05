import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { resolveHermesHome } from "../../../core/config/hermes-home.js";

/**
 * Regression: issue #2221 — the plugin's default Hermes home was
 * `~/.hermes` on every platform. On Windows, Hermes itself uses
 * `%LOCALAPPDATA%\hermes` (HERMES_HOME). These tests pin the four
 * branches of the shared resolver so both bridge.cts and bridge.mts,
 * plus the various server routes and paths.ts, share one convention.
 */
describe("config/hermes-home", () => {
  it("HERMES_HOME env overrides everything on POSIX", () => {
    const home = resolveHermesHome(
      { HERMES_HOME: "/tmp/custom-hermes", HOME: "/home/alice" },
      "linux",
    );
    // Path.resolve normalises; ensure the override is preserved.
    expect(home.endsWith("custom-hermes")).toBe(true);
  });

  it("HERMES_HOME env overrides everything on Windows", () => {
    const home = resolveHermesHome(
      {
        HERMES_HOME: "D:\\hermes-workshop",
        LOCALAPPDATA: "C:\\Users\\bob\\AppData\\Local",
      },
      "win32",
    );
    expect(home.includes("hermes-workshop")).toBe(true);
  });

  it("Windows uses LOCALAPPDATA/hermes when HERMES_HOME is unset", () => {
    const home = resolveHermesHome(
      { LOCALAPPDATA: "C:\\Users\\bob\\AppData\\Local" },
      "win32",
    );
    // Node's path.resolve on POSIX won't touch drive letters, but the
    // final segment must always be "hermes" and the preceding segment
    // "Local".
    const normalized = home.replace(/\\/g, "/");
    expect(normalized.endsWith("/hermes")).toBe(true);
    expect(normalized.includes("AppData/Local/hermes")).toBe(true);
  });

  it("Windows falls back to <home>/AppData/Local/hermes when LOCALAPPDATA is missing", () => {
    const home = resolveHermesHome({ HOME: "/mnt/user" }, "win32");
    const normalized = home.replace(/\\/g, "/");
    expect(normalized.endsWith("AppData/Local/hermes")).toBe(true);
  });

  it("POSIX default is ~/.hermes", () => {
    const home = resolveHermesHome({ HOME: "/home/alice" }, "linux");
    const normalized = home.replace(/\\/g, "/");
    expect(normalized).toBe(join("/home/alice", ".hermes"));
  });

  it("POSIX default on darwin honours HOME", () => {
    const home = resolveHermesHome({ HOME: "/Users/carol" }, "darwin");
    const normalized = home.replace(/\\/g, "/");
    expect(normalized).toBe(join("/Users/carol", ".hermes"));
  });
});
