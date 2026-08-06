import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";

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
    expect(home).toBe(posix.resolve("/tmp/custom-hermes"));
  });

  it("HERMES_HOME env overrides everything on Windows", () => {
    const home = resolveHermesHome(
      {
        HERMES_HOME: "D:\\hermes-workshop",
        LOCALAPPDATA: "C:\\Users\\bob\\AppData\\Local",
      },
      "win32",
    );
    expect(home).toBe(win32.resolve("D:\\hermes-workshop"));
  });

  it("Windows uses LOCALAPPDATA/hermes when HERMES_HOME is unset", () => {
    const home = resolveHermesHome(
      { LOCALAPPDATA: "C:\\Users\\bob\\AppData\\Local" },
      "win32",
    );
    expect(home).toBe(win32.resolve("C:\\Users\\bob\\AppData\\Local\\hermes"));
  });

  it("Windows falls back to <home>/AppData/Local/hermes when LOCALAPPDATA is missing", () => {
    const home = resolveHermesHome(
      { USERPROFILE: "C:\\Users\\bob", HOME: "D:\\fallback" },
      "win32",
    );
    expect(home).toBe(win32.resolve("C:\\Users\\bob\\AppData\\Local\\hermes"));
  });

  it("Windows expands a tilde override against USERPROFILE", () => {
    const home = resolveHermesHome(
      {
        HERMES_HOME: "~/hermes-workshop",
        USERPROFILE: "C:\\Users\\bob",
        HOME: "D:\\fallback",
      },
      "win32",
    );
    expect(home).toBe(win32.resolve("C:\\Users\\bob\\hermes-workshop"));
  });

  it("POSIX default is ~/.hermes", () => {
    const home = resolveHermesHome({ HOME: "/home/alice" }, "linux");
    expect(home).toBe(posix.resolve("/home/alice/.hermes"));
  });

  it("POSIX default on darwin honours HOME", () => {
    const home = resolveHermesHome({ HOME: "/Users/carol" }, "darwin");
    expect(home).toBe(posix.resolve("/Users/carol/.hermes"));
  });
});
