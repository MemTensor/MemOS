import test from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.js";

const createApi = (hostVersion) => {
  const registeredHooks = [];
  const originalArgv1 = process.argv[1];
  process.argv[1] = `C:\\Users\\lee\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\openclaw@${hostVersion}\\node_modules\\openclaw\\openclaw.mjs`;

  const api = {
    config: { hooks: { internal: { enabled: false } } },
    logger: {},
    pluginConfig: {
      apiKey: "mpg-test",
      recallEnabled: false,
      addEnabled: false,
    },
    on: (hookName, handler) => {
      registeredHooks.push({ hookName, handler });
    },
    registerHook: () => {},
  };

  return {
    api,
    registeredHooks,
    restore: () => {
      process.argv[1] = originalArgv1;
    },
  };
};

test("registers before_prompt_build on OpenClaw hosts that support the phase-specific hook", () => {
  const { api, registeredHooks, restore } = createApi("2026.5.7");
  try {
    plugin.register(api);
  } finally {
    restore();
  }

  assert.ok(registeredHooks.some((hook) => hook.hookName === "before_prompt_build"));
  assert.ok(!registeredHooks.some((hook) => hook.hookName === "before_agent_start"));
});

test("falls back to before_agent_start on older OpenClaw hosts", () => {
  const { api, registeredHooks, restore } = createApi("2026.4.26");
  try {
    plugin.register(api);
  } finally {
    restore();
  }

  assert.ok(registeredHooks.some((hook) => hook.hookName === "before_agent_start"));
  assert.ok(!registeredHooks.some((hook) => hook.hookName === "before_prompt_build"));
});
