/**
 * E2E test: 验证 capabilities 开启时，summarizer/embedding 自动使用 openclaw provider
 *
 * 测试场景：
 *   1. capabilities 全关 + 无显式 provider → summarizer/embedding 为 undefined
 *   2. hostCompletion=true + 无显式 summarizer → summarizer.provider 自动变为 "openclaw"
 *   3. hostEmbedding=true + 无显式 embedding → embedding.provider 自动变为 "openclaw"
 *   4. 显式配了 provider (如 openai) + capabilities 开启 → 保留用户配置，不覆盖
 *   5. buildContext 传入 hostModels 时，openclawAPI 实例被正确创建
 *
 * Usage: npx tsx tests/e2e-capabilities-fallback.ts
 */

import { resolveConfig, buildContext } from "../src/config";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Test 1: capabilities 全关 ───────────────────────────────────────

function test1_capabilitiesOff() {
  console.log("\n═══ Test 1: capabilities 全关，无显式 provider ═══");
  const config = resolveConfig({}, "/tmp/test");

  assert(config.summarizer === undefined, "summarizer 为 undefined");
  assert(config.embedding === undefined, "embedding 为 undefined");
  assert(config.sharing?.capabilities?.hostCompletion === false, "hostCompletion = false");
  assert(config.sharing?.capabilities?.hostEmbedding === false, "hostEmbedding = false");
}

// ── Test 2: hostCompletion=true → summarizer fallback to openclaw ───

function test2_hostCompletionFallback() {
  console.log("\n═══ Test 2: hostCompletion=true → summarizer.provider = 'openclaw' ═══");
  const config = resolveConfig({
    sharing: {
      capabilities: { hostCompletion: true, hostEmbedding: false },
    },
  }, "/tmp/test");

  assert(config.summarizer !== undefined, "summarizer 不为 undefined");
  assert(config.summarizer?.provider === "openclaw", `summarizer.provider = "${config.summarizer?.provider}" (期望 "openclaw")`);
  assert(config.summarizer?.capabilities?.hostCompletion === true, "summarizer.capabilities.hostCompletion = true");
  assert(config.embedding === undefined, "embedding 仍为 undefined (hostEmbedding 关)");
}

// ── Test 3: hostEmbedding=true → embedding fallback to openclaw ─────

function test3_hostEmbeddingFallback() {
  console.log("\n═══ Test 3: hostEmbedding=true → embedding.provider = 'openclaw' ═══");
  const config = resolveConfig({
    sharing: {
      capabilities: { hostCompletion: false, hostEmbedding: true },
    },
  }, "/tmp/test");

  assert(config.embedding !== undefined, "embedding 不为 undefined");
  assert(config.embedding?.provider === "openclaw", `embedding.provider = "${config.embedding?.provider}" (期望 "openclaw")`);
  assert(config.embedding?.capabilities?.hostEmbedding === true, "embedding.capabilities.hostEmbedding = true");
  assert(config.summarizer === undefined, "summarizer 仍为 undefined (hostCompletion 关)");
}

// ── Test 4: 两个都开 ───────────────────────────────────────────────

function test4_bothEnabled() {
  console.log("\n═══ Test 4: 两个 capabilities 都开 ═══");
  const config = resolveConfig({
    sharing: {
      capabilities: { hostCompletion: true, hostEmbedding: true },
    },
  }, "/tmp/test");

  assert(config.summarizer?.provider === "openclaw", `summarizer.provider = "${config.summarizer?.provider}"`);
  assert(config.embedding?.provider === "openclaw", `embedding.provider = "${config.embedding?.provider}"`);
  assert(config.summarizer?.capabilities?.hostCompletion === true, "summarizer 带 hostCompletion capability");
  assert(config.embedding?.capabilities?.hostEmbedding === true, "embedding 带 hostEmbedding capability");
}

// ── Test 5: 显式配了 provider → 不被覆盖 ───────────────────────────

function test5_explicitProviderNotOverridden() {
  console.log("\n═══ Test 5: 显式配了 provider，capabilities 开启但不覆盖 ═══");
  const config = resolveConfig({
    summarizer: { provider: "openai_compatible", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    embedding: { provider: "openai_compatible", endpoint: "https://api.openai.com/v1", model: "text-embedding-3-small" },
    sharing: {
      capabilities: { hostCompletion: true, hostEmbedding: true },
    },
  }, "/tmp/test");

  assert(config.summarizer?.provider === "openai_compatible", `summarizer.provider 保留为 "${config.summarizer?.provider}"`);
  assert(config.embedding?.provider === "openai_compatible", `embedding.provider 保留为 "${config.embedding?.provider}"`);
  // capabilities 仍然被传递
  assert(config.summarizer?.capabilities?.hostCompletion === true, "summarizer 仍带 capabilities");
  assert(config.embedding?.capabilities?.hostEmbedding === true, "embedding 仍带 capabilities");
}

// ── Test 6: buildContext 创建 openclawAPI ────────────────────────────

function test6_buildContextCreatesAPI() {
  console.log("\n═══ Test 6: buildContext + hostModels → openclawAPI 实例 ═══");

  const hostModels = {
    providers: {
      "test-provider": {
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        api: "openai-completions",
        models: [
          { id: "gpt-4o-mini", name: "GPT-4o Mini" },
          { id: "text-embedding-3-small", name: "Embedding Small" },
        ],
      },
    },
  };

  // 6a. capabilities 开 → openclawAPI 存在
  const ctx1 = buildContext("/tmp/test", "/tmp/ws", {
    sharing: { capabilities: { hostCompletion: true, hostEmbedding: true } },
  }, log, hostModels);

  assert(ctx1.openclawAPI !== undefined, "openclawAPI 实例被创建 (capabilities 开)");
  assert(ctx1.config.summarizer?.provider === "openclaw", "context 中 summarizer = openclaw");
  assert(ctx1.config.embedding?.provider === "openclaw", "context 中 embedding = openclaw");

  // 6b. capabilities 关 → openclawAPI 不存在
  const ctx2 = buildContext("/tmp/test", "/tmp/ws", {}, log, hostModels);

  assert(ctx2.openclawAPI === undefined, "openclawAPI 为 undefined (capabilities 关)");
}

// ── Test 7: provider=null + capabilities 开 → fallback ──────────────

function test7_nullProviderFallback() {
  console.log("\n═══ Test 7: provider 为 null/undefined + capabilities 开 → fallback ═══");
  const config = resolveConfig({
    summarizer: { temperature: 0.5 } as any, // 有配置但没 provider
    embedding: { model: "custom-model" } as any,
    sharing: {
      capabilities: { hostCompletion: true, hostEmbedding: true },
    },
  }, "/tmp/test");

  assert(config.summarizer?.provider === "openclaw", `summarizer.provider fallback 到 "${config.summarizer?.provider}"`);
  assert(config.embedding?.provider === "openclaw", `embedding.provider fallback 到 "${config.embedding?.provider}"`);
  // 原有配置保留
  assert((config.summarizer as any)?.temperature === 0.5, "summarizer 保留原有 temperature 配置");
  assert((config.embedding as any)?.model === "custom-model", "embedding 保留原有 model 配置");
}

// ── Main ────────────────────────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  E2E: Capabilities → Provider Fallback 验证             ║");
console.log("╚══════════════════════════════════════════════════════════╝");

test1_capabilitiesOff();
test2_hostCompletionFallback();
test3_hostEmbeddingFallback();
test4_bothEnabled();
test5_explicitProviderNotOverridden();
test6_buildContextCreatesAPI();
test7_nullProviderFallback();

console.log("\n══════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
