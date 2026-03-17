#!/usr/bin/env npx tsx
/**
 * Regenerate a skill's SKILL.md from its source task, using updated prompts.
 * Usage: npx tsx scripts/refresh-skill.ts <skill-id>
 */
import { buildContext } from "../src/config";
import { SqliteStore } from "../src/storage/sqlite";
import { Embedder } from "../src/embedding";
import { RecallEngine } from "../src/recall/engine";
import { SkillGenerator } from "../src/skill/generator";

const skillId = process.argv[2];
if (!skillId) {
  console.error("Usage: npx tsx scripts/refresh-skill.ts <skill-id>");
  process.exit(1);
}

import * as fs from "fs";

const home = process.env.HOME ?? "/tmp";
const stateDir = `${home}/.openclaw`;
const workspaceDir = `${home}/.openclaw/workspace`;

// Read plugin config from openclaw.json
let pluginConfig: Record<string, unknown> | undefined;
try {
  const oc = JSON.parse(fs.readFileSync(`${stateDir}/openclaw.json`, "utf-8"));
  pluginConfig = oc?.plugins?.entries?.["memos-local"]?.config;
} catch {}

const ctx = buildContext(stateDir, workspaceDir, pluginConfig, {
  info: (m: string) => console.log(`[INFO] ${m}`),
  debug: (m: string) => console.log(`[DEBUG] ${m}`),
  warn: (m: string) => console.warn(`[WARN] ${m}`),
  error: (m: string) => console.error(`[ERROR] ${m}`),
});

const store = new SqliteStore(ctx.config.storage!.dbPath, ctx.log);
const embedder = new Embedder(ctx.config.embedding!, ctx.log);
const engine = new RecallEngine(store, embedder, ctx);
const generator = new SkillGenerator(store, engine, ctx);

const skill = store.getSkill(skillId);
if (!skill) {
  console.error(`Skill not found: ${skillId}`);
  process.exit(1);
}

// Find source task
const db = (store as any).db;
const versionRow = db.prepare(
  "SELECT source_task_id FROM skill_versions WHERE skill_id = ? ORDER BY version DESC LIMIT 1"
).get(skillId) as { source_task_id: string } | undefined;

if (!versionRow?.source_task_id) {
  console.error("No source task found for this skill");
  process.exit(1);
}

const task = store.getTask(versionRow.source_task_id);
if (!task) {
  console.error(`Task not found: ${versionRow.source_task_id}`);
  process.exit(1);
}

const chunks = store.getChunksByTask(task.id);
console.log(`Regenerating skill "${skill.name}" from task "${task.title}" (${chunks.length} chunks)...`);

const evalResult = {
  shouldGenerate: true,
  reason: "refresh",
  suggestedName: skill.name,
  suggestedTags: JSON.parse(skill.tags || "[]"),
  confidence: 0.9,
};

generator.generate(task, chunks, evalResult).then((newSkill) => {
  console.log(`\nDone! Skill regenerated:`);
  console.log(`  Name: ${newSkill.name}`);
  console.log(`  Status: ${newSkill.status}`);
  console.log(`  Quality: ${newSkill.qualityScore}`);
  console.log(`  Dir: ${newSkill.dirPath}`);
  store.close();
}).catch((err) => {
  console.error("Failed:", err);
  store.close();
  process.exit(1);
});
