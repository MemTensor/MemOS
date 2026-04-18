import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { validateNativeBinding } = require("../scripts/native-binding.cjs");

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
});
