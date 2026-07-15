#!/usr/bin/env npx tsx
/**
 * Multi-agent data isolation test.
 *
 * Writes data with different owner tags via initPlugin, then creates
 * a separate RecallEngine to verify search isolation with ownerFilter.
 *
 * Usage:
 *   npx tsx scripts/test-agent-isolation.ts
 */

import * as fs from "fs";
import * as path from "path";
import { initPlugin } from "../src/index";
import { SqliteStore } from "../src/storage/sqlite";
import { Embedder } from "../src/embedding";
import { RecallEngine } from "../src/recall/engine";
import { buildContext } from "../src/config";

const RUN_ID = Date.now();
const AGENT_A = "iso-test-alpha";
const AGENT_B = "iso-test-beta";

const UNIQUE_A = `AlphaUniqueKey${RUN_ID}`;
const UNIQUE_B = `BetaUniqueKey${RUN_ID}`;

const MSG_A1 = `我正在用 ${UNIQUE_A} 部署一个私有 Redis 缓存集群，配置主从复制和哨兵模式，端口 6379。`;
const MSG_A2 = `${UNIQUE_A} 的 Redis 集群已经部署完成，延迟从 50ms 降到了 3ms，命中率 95%。`;

const MSG_B1 = `帮我设置 ${UNIQUE_B} 的 PostgreSQL 数据库迁移方案，从 v14 升级到 v16，数据量约 500GB。`;
const MSG_B2 = `${UNIQUE_B} 的 PostgreSQL 迁移完成了，用了 pg_upgrade --link 模式，停机只有 2 分钟。`;

let passed = 0;
let failed = 0;

function log(msg: string) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${t}] ${msg}`);
}

function assert(name: string, condition: boolean, detail: string) {
  if (condition) {
    passed++;
    log(`  ✅ ${name}`);
  } else {
    failed++;
    log(`  ❌ ${name}: ${detail}`);
  }
}

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  Multi-Agent Data Isolation Test");
  log("═══════════════════════════════════════════════════════");
  log(`  Agent A: ${AGENT_A}  (keyword: ${UNIQUE_A})`);
  log(`  Agent B: ${AGENT_B}  (keyword: ${UNIQUE_B})`);
  log("");

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const stateDir = path.join(home, ".openclaw");
  const cfgPath = path.join(stateDir, "openclaw.json");
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  const pluginCfg = raw?.plugins?.entries?.["memos-local-openclaw-plugin"]?.config ?? {};

  // ── Step 1: Ingest data with different owners ──
  log("── Step 1: Ingesting data with different agent owners ──");

  const plugin = initPlugin({ stateDir, config: pluginCfg, log: silentLog });

  const sessionA = `iso-session-a-${RUN_ID}`;
  const sessionB = `iso-session-b-${RUN_ID}`;

  plugin.onConversationTurn(
    [{ role: "user", content: MSG_A1 }, { role: "assistant", content: MSG_A2 }],
    sessionA,
    `agent:${AGENT_A}`,
  );
  log(`  Enqueued 2 messages for agent:${AGENT_A}`);

  plugin.onConversationTurn(
    [{ role: "user", content: MSG_B1 }, { role: "assistant", content: MSG_B2 }],
    sessionB,
    `agent:${AGENT_B}`,
  );
  log(`  Enqueued 2 messages for agent:${AGENT_B}`);

  log("  Flushing ingest pipeline...");
  await plugin.flush();
  log("  Waiting 3s for embedding completion...");
  await new Promise((r) => setTimeout(r, 3000));
  await plugin.flush();
  log("  Done.");

  await plugin.shutdown();

  // ── Step 2: Open a read-only store + engine for verification ──
  log("\n── Step 2: Verify owner tags in raw DB ──");

  const ctx = buildContext(stateDir, process.cwd(), pluginCfg, silentLog);
  const store = new SqliteStore(ctx.config.storage!.dbPath!, silentLog);
  const embedder = new Embedder(ctx.config.embedding, silentLog);
  const engine = new RecallEngine(store, embedder, ctx);

  const db = (store as any).db;

  const chunksA = db.prepare(
    `SELECT id, owner, session_key, role, substr(content, 1, 80) as preview
     FROM chunks WHERE content LIKE ? AND dedup_status = 'active'`
  ).all(`%${UNIQUE_A}%`) as any[];

  const chunksB = db.prepare(
    `SELECT id, owner, session_key, role, substr(content, 1, 80) as preview
     FROM chunks WHERE content LIKE ? AND dedup_status = 'active'`
  ).all(`%${UNIQUE_B}%`) as any[];

  log(`  Chunks with keyword-A: ${chunksA.length}`);
  for (const c of chunksA) {
    log(`    owner=${c.owner}  role=${c.role}  preview=${c.preview.slice(0, 50)}...`);
  }

  log(`  Chunks with keyword-B: ${chunksB.length}`);
  for (const c of chunksB) {
    log(`    owner=${c.owner}  role=${c.role}  preview=${c.preview.slice(0, 50)}...`);
  }

  assert("Keyword-A chunks exist", chunksA.length > 0, "No chunks — ingest failed");
  assert("Keyword-B chunks exist", chunksB.length > 0, "No chunks — ingest failed");

  if (chunksA.length > 0) {
    const ownersA = new Set(chunksA.map((c: any) => c.owner));
    assert(
      "Keyword-A owner = agent:" + AGENT_A,
      ownersA.size === 1 && ownersA.has(`agent:${AGENT_A}`),
      `Got: ${[...ownersA].join(", ")}`,
    );
  }

  if (chunksB.length > 0) {
    const ownersB = new Set(chunksB.map((c: any) => c.owner));
    assert(
      "Keyword-B owner = agent:" + AGENT_B,
      ownersB.size === 1 && ownersB.has(`agent:${AGENT_B}`),
      `Got: ${[...ownersB].join(", ")}`,
    );
  }

  // ── Step 3: Search isolation via RecallEngine ──
  log("\n── Step 3: Search isolation (RecallEngine) ──");

  const search = async (query: string, owner: string) =>
    engine.search({ query, maxResults: 10, ownerFilter: [`agent:${owner}`, "public"] });

  const allowedOwners = (owner: string) => new Set([`agent:${owner}`, "public"]);

  const checkHitOwners = (hits: any[], allowed: Set<string>): string[] => {
    const violations: string[] = [];
    for (const h of hits) {
      const chunk = store.getChunk(h.ref.chunkId);
      if (chunk && !allowed.has(chunk.owner)) {
        violations.push(`chunkId=${h.ref.chunkId} owner=${chunk.owner}`);
      }
    }
    return violations;
  };

  // 3a. Agent-A searches own keyword — should find own data
  const resAA = await search(UNIQUE_A, AGENT_A);
  assert("Agent-A finds own keyword-A", resAA.hits.length > 0, `Got ${resAA.hits.length} hits`);

  // 3b. Agent-A searches keyword-B — results must only contain Agent-A or public data
  const resAB = await search(UNIQUE_B, AGENT_A);
  const violationsAB = checkHitOwners(resAB.hits, allowedOwners(AGENT_A));
  assert(
    "Agent-A results for keyword-B contain NO agent-B data ← ISOLATION",
    violationsAB.length === 0,
    `Found ${violationsAB.length} leaks: ${violationsAB.join("; ")}`,
  );
  log(`    (Agent-A got ${resAB.hits.length} hits for keyword-B, all from own/public — OK)`);

  // 3c. Agent-B searches own keyword — should find own data
  const resBB = await search(UNIQUE_B, AGENT_B);
  assert("Agent-B finds own keyword-B", resBB.hits.length > 0, `Got ${resBB.hits.length} hits`);

  // 3d. Agent-B searches keyword-A — results must only contain Agent-B or public data
  const resBA = await search(UNIQUE_A, AGENT_B);
  const violationsBA = checkHitOwners(resBA.hits, allowedOwners(AGENT_B));
  assert(
    "Agent-B results for keyword-A contain NO agent-A data ← ISOLATION",
    violationsBA.length === 0,
    `Found ${violationsBA.length} leaks: ${violationsBA.join("; ")}`,
  );
  log(`    (Agent-B got ${resBA.hits.length} hits for keyword-A, all from own/public — OK)`);

  // 3e. agent:main results should not contain iso-test agents' data
  const resMainA = await search(UNIQUE_A, "main");
  const violationsMainA = checkHitOwners(resMainA.hits, allowedOwners("main"));
  assert(
    "agent:main results contain no iso-test-alpha data",
    violationsMainA.length === 0,
    `Found ${violationsMainA.length} leaks: ${violationsMainA.join("; ")}`,
  );

  const resMainB = await search(UNIQUE_B, "main");
  const violationsMainB = checkHitOwners(resMainB.hits, allowedOwners("main"));
  assert(
    "agent:main results contain no iso-test-beta data",
    violationsMainB.length === 0,
    `Found ${violationsMainB.length} leaks: ${violationsMainB.join("; ")}`,
  );

  // ── Step 4: FTS isolation ──
  log("\n── Step 4: FTS isolation ──");

  const ftsAA = store.ftsSearch(UNIQUE_A, 10, [`agent:${AGENT_A}`, "public"]);
  assert("FTS: Agent-A finds keyword-A", ftsAA.length > 0, `Got ${ftsAA.length}`);

  const ftsAB = store.ftsSearch(UNIQUE_B, 10, [`agent:${AGENT_A}`, "public"]);
  assert("FTS: Agent-A cannot find keyword-B", ftsAB.length === 0, `Got ${ftsAB.length} — BROKEN!`);

  const ftsBB = store.ftsSearch(UNIQUE_B, 10, [`agent:${AGENT_B}`, "public"]);
  assert("FTS: Agent-B finds keyword-B", ftsBB.length > 0, `Got ${ftsBB.length}`);

  const ftsBA = store.ftsSearch(UNIQUE_A, 10, [`agent:${AGENT_B}`, "public"]);
  assert("FTS: Agent-B cannot find keyword-A", ftsBA.length === 0, `Got ${ftsBA.length} — BROKEN!`);

  // ── Summary ──
  log("\n═══════════════════════════════════════════════════════");
  log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    log("  🎉 All isolation tests passed!");
  } else {
    log("  ⚠ Some isolation tests FAILED");
  }
  log("═══════════════════════════════════════════════════════");

  store.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
