/**
 * E2E test: Host Model Proxy (OpenClawAPIClient)
 *
 * This script performs REAL API calls to verify the host model proxy works end-to-end.
 * It reads provider configs from ~/.openclaw/openclaw.json and tests:
 *   1. OpenClawAPIClient construction with real host model configs
 *   2. Real embedding API call
 *   3. Real completion API call
 *   4. Full pipeline: Hub start → Client join → capabilities propagation → model proxy calls
 *
 * Usage: npx tsx tests/e2e-host-model-proxy.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenClawAPIClient, type HostModelsConfig } from "../src/openclaw-api";
import { SqliteStore } from "../src/storage/sqlite";
import { HubServer } from "../src/hub/server";
import { buildContext } from "../src/config";

// ── Logger ──────────────────────────────────────────────────────────

const log = {
  debug: (...args: unknown[]) => console.log("  [debug]", ...args),
  info: (...args: unknown[]) => console.log("  [info]", ...args),
  warn: (...args: unknown[]) => console.warn("  [warn]", ...args),
  error: (...args: unknown[]) => console.error("  [error]", ...args),
};

// ── Helpers ─────────────────────────────────────────────────────────

function loadOpenClawConfig(): any {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cfgPath = path.join(home, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`OpenClaw config not found at ${cfgPath}`);
  }
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}

function extractHostModels(openclawConfig: any): HostModelsConfig {
  const providers = openclawConfig?.models?.providers;
  if (!providers || Object.keys(providers).length === 0) {
    throw new Error("No model providers found in openclaw.json");
  }
  return { providers };
}

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

// ── Test 1: OpenClawAPIClient construction ──────────────────────────

async function testClientConstruction() {
  console.log("\n═══ Test 1: OpenClawAPIClient construction ═══");

  const config = loadOpenClawConfig();
  const hostModels = extractHostModels(config);

  console.log(`  Found ${Object.keys(hostModels.providers!).length} providers:`);
  for (const [name, p] of Object.entries(hostModels.providers!) as any) {
    console.log(`    - ${name}: ${p.models?.length ?? 0} models, api=${p.api ?? "default"}`);
  }

  const client = new OpenClawAPIClient(log, hostModels);
  assert(client !== null, "OpenClawAPIClient created successfully");

  return { client, hostModels };
}

// ── Test 2: Real embedding call ─────────────────────────────────────

async function testEmbedding(client: OpenClawAPIClient) {
  console.log("\n═══ Test 2: Real embedding API call ═══");

  try {
    const result = await client.embed({
      texts: ["Hello world", "This is a test of the host model proxy"],
    });

    assert(result.embeddings.length === 2, `Got ${result.embeddings.length} embeddings (expected 2)`);
    assert(result.dimensions > 0, `Embedding dimensions: ${result.dimensions}`);
    assert(result.embeddings[0].length === result.dimensions, `First embedding length matches dimensions`);
    assert(result.embeddings[1].length === result.dimensions, `Second embedding length matches dimensions`);

    // Sanity: embeddings should not be all zeros
    const nonZero = result.embeddings[0].some((v) => v !== 0);
    assert(nonZero, "Embedding values are non-zero");

    console.log(`  📊 Embedding sample (first 5 dims): [${result.embeddings[0].slice(0, 5).map(v => v.toFixed(4)).join(", ")}...]`);
  } catch (err: any) {
    console.error(`  ❌ Embedding call failed: ${err.message}`);
    failed++;
  }
}

// ── Test 3: Real completion call ────────────────────────────────────

async function testCompletion(client: OpenClawAPIClient) {
  console.log("\n═══ Test 3: Real completion API call ═══");

  try {
    const result = await client.complete({
      prompt: "Reply with exactly one word: hello",
      maxTokens: 10,
      temperature: 0,
    });

    assert(typeof result.text === "string", `Got completion text (type: string)`);
    assert(result.text.length > 0, `Completion is non-empty: "${result.text.trim()}"`);
    assert(result.text.length < 200, `Completion is reasonably short: ${result.text.length} chars`);
  } catch (err: any) {
    console.error(`  ❌ Completion call failed: ${err.message}`);
    failed++;
  }
}

// ── Test 4: Full pipeline — Hub + capabilities + model proxy ────────

async function testFullPipeline(hostModels: HostModelsConfig) {
  console.log("\n═══ Test 4: Full pipeline — Hub + buildContext + model proxy ═══");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-e2e-proxy-"));
  const dbPath = path.join(dir, "test.db");

  try {
    // 4a. Start Hub
    console.log("  → Starting Hub server...");
    const store = new SqliteStore(dbPath, log);
    const hub = new HubServer({
      store,
      log,
      config: {
        sharing: {
          enabled: true,
          role: "hub",
          hub: { port: 18950, teamName: "E2E-Proxy-Test", teamToken: "e2e-proxy-token" },
        },
      },
      dataDir: dir,
    } as any);

    const hubUrl = await hub.start();
    assert(hubUrl === "http://127.0.0.1:18950", `Hub started at ${hubUrl}`);

    // 4b. Verify Hub /info
    const infoRes = await fetch(`${hubUrl}/api/v1/hub/info`);
    assert(infoRes.ok, `Hub /info responded OK`);
    const info = await infoRes.json() as any;
    assert(info.teamName === "E2E-Proxy-Test", `Hub teamName: ${info.teamName}`);
    console.log(`  📡 Hub info: team=${info.teamName}, version=${info.apiVersion}`);

    // 4c. Client join
    console.log("  → Client joining Hub...");
    const joinRes = await fetch(`${hubUrl}/api/v1/hub/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "e2e-tester",
        deviceName: "test-device",
        teamToken: "e2e-proxy-token",
      }),
    });
    assert(joinRes.ok, `Client join responded OK`);
    const joinData = await joinRes.json() as any;
    assert(!!joinData.userId, `Got userId: ${joinData.userId}`);
    assert(joinData.status === "pending_approval" || joinData.status === "active", `Status: ${joinData.status}`);

    // 4d. Admin approve
    const authPath = path.join(dir, "hub-auth.json");
    const authState = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const adminToken = authState.bootstrapAdminToken;

    const approveRes = await fetch(`${hubUrl}/api/v1/hub/admin/approve-user`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId: joinData.userId, username: "e2e-tester" }),
    });
    assert(approveRes.ok, `Admin approved user`);
    const approveData = await approveRes.json() as any;
    const userToken = approveData.token;
    assert(!!userToken, `Got user token`);

    // 4e. Verify /me
    const meRes = await fetch(`${hubUrl}/api/v1/hub/me`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert(meRes.ok, `/me responded OK`);
    const meData = await meRes.json() as any;
    assert(meData.username === "e2e-tester", `Username: ${meData.username}`);

    // 4f. buildContext with capabilities enabled + hostModels
    console.log("  → Building context with host model proxy...");
    const ctx = buildContext(dir, process.cwd(), {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: hubUrl,
          userToken,
          teamToken: "e2e-proxy-token",
        },
        capabilities: {
          hostEmbedding: true,
          hostCompletion: true,
        },
      },
    }, log, hostModels);

    assert(ctx.config.sharing?.capabilities?.hostEmbedding === true, "hostEmbedding capability enabled");
    assert(ctx.config.sharing?.capabilities?.hostCompletion === true, "hostCompletion capability enabled");
    assert(ctx.openclawAPI !== undefined, "OpenClawAPI instance created in context");

    // 4g. Use the context's openclawAPI for real calls
    if (ctx.openclawAPI) {
      console.log("  → Testing embed via context.openclawAPI...");
      try {
        const embedResult = await ctx.openclawAPI.embed({ texts: ["pipeline test embedding"] });
        assert(embedResult.embeddings.length === 1, `Pipeline embed: got ${embedResult.embeddings.length} vector`);
        assert(embedResult.dimensions > 0, `Pipeline embed dimensions: ${embedResult.dimensions}`);
      } catch (err: any) {
        console.error(`  ❌ Pipeline embed failed: ${err.message}`);
        failed++;
      }

      console.log("  → Testing complete via context.openclawAPI...");
      try {
        const completeResult = await ctx.openclawAPI.complete({
          prompt: "Reply with exactly: OK",
          maxTokens: 5,
          temperature: 0,
        });
        assert(completeResult.text.length > 0, `Pipeline complete: "${completeResult.text.trim()}"`);
      } catch (err: any) {
        console.error(`  ❌ Pipeline complete failed: ${err.message}`);
        failed++;
      }
    }

    // 4h. Share a memory and search it
    console.log("  → Sharing memory to Hub...");
    const shareRes = await fetch(`${hubUrl}/api/v1/hub/tasks/share`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        task: {
          id: "e2e-task-1",
          sourceTaskId: "local-task-1",
          sourceUserId: joinData.userId,
          title: "Host Model Proxy Test",
          summary: "Testing host model proxy end to end",
          groupId: null,
          visibility: "public",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        chunks: [{
          id: "e2e-chunk-1",
          hubTaskId: "e2e-task-1",
          sourceTaskId: "local-task-1",
          sourceChunkId: "local-chunk-1",
          sourceUserId: joinData.userId,
          role: "assistant",
          content: "The host model proxy routes embedding and completion requests through the OpenClaw host's configured providers.",
          summary: "host model proxy routing",
          kind: "paragraph",
          createdAt: Date.now(),
        }],
      }),
    });
    assert(shareRes.ok, `Memory shared to Hub`);

    const searchRes = await fetch(`${hubUrl}/api/v1/hub/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ query: "host model proxy", maxResults: 5 }),
    });
    assert(searchRes.ok, `Hub search responded OK`);
    const searchData = await searchRes.json() as any;
    assert(searchData.hits?.length > 0, `Search found ${searchData.hits?.length} hits`);

    // Cleanup
    await hub.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("  → Hub stopped, temp dir cleaned up");

  } catch (err: any) {
    console.error(`  ❌ Pipeline error: ${err.message}`);
    console.error(err.stack);
    failed++;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  E2E Test: Host Model Proxy (Real API Calls)        ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  const { client, hostModels } = await testClientConstruction();
  await testEmbedding(client);
  await testCompletion(client);
  await testFullPipeline(hostModels);

  console.log("\n══════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
