import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  quarantineNativeBinding,
  validateNativeBinding,
} = require("../scripts/native-binding.cjs");

describe("postinstall native binding validation", () => {
  it("accepts a loadable native binding", () => {
    const result = validateNativeBinding("/tmp/fake.node", () => {});
    expect(result).toEqual({ ok: true, reason: "ok", message: "" });
  });

  it("treats NODE_MODULE_VERSION mismatches as not ready", () => {
    const result = validateNativeBinding("/tmp/fake.node", () => {
      throw new Error("The module was compiled with NODE_MODULE_VERSION 141 but this runtime needs 137.");
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("node-module-version");
    expect(result.message).toContain("NODE_MODULE_VERSION");
  });

  it("treats other load failures as not ready", () => {
    const result = validateNativeBinding("/tmp/fake.node", () => {
      throw new Error("dlopen(/tmp/fake.node, 0x0001): tried: '/tmp/fake.node' (mach-o file, but is an incompatible architecture)");
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("load-error");
    expect(result.message).toContain("incompatible architecture");
  });

  it("reports missing bindings explicitly", () => {
    const result = validateNativeBinding("");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing");
  });

  it("moves ABI-mismatched bindings aside before rebuild", () => {
    const calls: Array<[string, string, string?]> = [];
    const fsImpl = {
      existsSync: () => true,
      renameSync: (from: string, to: string) => calls.push(["rename", from, to]),
      unlinkSync: (target: string) => calls.push(["unlink", target]),
    };
    const staleBinding = [
      "C:",
      "Users",
      "me",
      ".openclaw",
      "extensions",
      "memos-local-openclaw-plugin",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ].join("\\");

    const result = quarantineNativeBinding(staleBinding, fsImpl, 123);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("renamed");
    expect(result.quarantinedPath).toContain("better_sqlite3.abi-mismatch-123.node");
    expect(calls).toEqual([
      [
        "rename",
        staleBinding,
        result.quarantinedPath,
      ],
    ]);
  });

  it("removes the stale binding if it cannot be renamed", () => {
    const calls: Array<[string, string]> = [];
    const fsImpl = {
      existsSync: () => true,
      renameSync: () => {
        throw new Error("EPERM");
      },
      unlinkSync: (target: string) => calls.push(["unlink", target]),
    };

    const result = quarantineNativeBinding("/tmp/better_sqlite3.node", fsImpl, 123);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("removed");
    expect(calls).toEqual([["unlink", "/tmp/better_sqlite3.node"]]);
  });
});
