import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveBridgeRuntimeMode } from "../../../bridge/runtime-mode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..", "..");

describe("bridge runtime mode", () => {
  it.each([
    {
      agent: "hermes" as const,
      daemon: true,
      hostLlmEnabled: false,
      evolutionWorkerEnabled: false,
    },
    {
      agent: "hermes" as const,
      daemon: false,
      hostLlmEnabled: true,
      evolutionWorkerEnabled: true,
    },
    {
      agent: "openclaw" as const,
      daemon: true,
      hostLlmEnabled: false,
      evolutionWorkerEnabled: true,
    },
    {
      agent: "openclaw" as const,
      daemon: false,
      hostLlmEnabled: true,
      evolutionWorkerEnabled: true,
    },
  ])(
    "resolves $agent daemon=$daemon without letting a headless Hermes daemon consume jobs",
    ({ agent, daemon, hostLlmEnabled, evolutionWorkerEnabled }) => {
      expect(resolveBridgeRuntimeMode({ agent, daemon })).toEqual({
        hostLlmEnabled,
        evolutionWorkerEnabled,
      });
    },
  );

  it.each(["bridge.mts", "bridge.cts"])(
    "keeps %s wired to the shared runtime-mode policy",
    (entry) => {
      const source = readFileSync(resolve(PLUGIN_ROOT, entry), "utf8");
      expect(source).toContain("resolveBridgeRuntimeMode");
      expect(source).toContain(
        "evolutionWorkerEnabled: runtimeMode.evolutionWorkerEnabled",
      );
    },
  );
});
