#!/usr/bin/env tsx
/**
 * scripts/re-embed.ts — re-embed chunks under the currently configured
 * embedding provider/model. See issue #1333.
 *
 * Usage:
 *   pnpm exec tsx scripts/re-embed.ts [--missing-only] [--dry-run]
 *                                     [--limit N] [--batch-size N]
 *                                     [--db PATH] [--config PATH]
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { Embedder } from "../src/embedding";
import { resolveConfig } from "../src/config";
import type { Logger, MemosLocalConfig } from "../src/types";

interface CliOpts {
  missingOnly: boolean;
  dryRun: boolean;
  limit?: number;
  batchSize: number;
  dbPath?: string;
  configPath: string;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    missingOnly: false,
    dryRun: false,
    batchSize: 32,
    configPath: path.join(os.homedir(), ".openclaw", "openclaw.json"),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--missing-only") opts.missingOnly = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--batch-size") opts.batchSize = Number(argv[++i]);
    else if (a === "--db") opts.dbPath = argv[++i];
    else if (a === "--config") opts.configPath = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

const HELP = `Re-embed chunks under the currently configured embedding provider/model.

Usage: tsx scripts/re-embed.ts [options]

  --missing-only        Only re-embed chunks that have no embedding row.
  --dry-run             Print the plan only; do not write embeddings.
  --limit <n>           Process at most n chunks.
  --batch-size <n>      Embed n chunks per provider call (default 32).
  --db <path>           Override DB path (default reads ~/.openclaw config).
  --config <path>       Override openclaw.json path (default ~/.openclaw/openclaw.json).
  -h, --help            Show this help.

Behaviour: scans for chunks whose embedding row's (provider, model, dimensions)
does not match the current Embedder — plus rows tagged as 'legacy' (empty
producer columns, from before this feature) and chunks with no embedding row.
Re-embeds them in batches; never deletes existing data. Re-running picks up
where it left off because the candidate list is re-computed each run.
`;

function makeLog(): Logger {
  return {
    debug: (...a) => console.debug("[re-embed]", ...a),
    info: (...a) => console.info("[re-embed]", ...a),
    warn: (...a) => console.warn("[re-embed]", ...a),
    error: (...a) => console.error("[re-embed]", ...a),
  };
}

function loadPluginConfig(configPath: string): Partial<MemosLocalConfig> {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  const plugins = (raw.plugins as Record<string, unknown> | undefined) ?? {};
  const entries = ((plugins as { entries?: Record<string, unknown> }).entries ?? {}) as Record<string, { config?: Partial<MemosLocalConfig> }>;
  const configs = ((plugins as { configs?: Record<string, unknown> }).configs ?? {}) as Record<string, { config?: Partial<MemosLocalConfig> }>;
  const candidate =
    entries["memos-local"]?.config ??
    entries["memos-local-openclaw-plugin"]?.config ??
    configs["memos-local"]?.config ??
    {};
  return candidate;
}

function formatStats(label: string, s: {
  total: number;
  matched: number;
  mismatched: number;
  legacy: number;
  missing: number;
  current: { provider: string; model: string; dimensions: number };
  byProducer: Array<{ provider: string; model: string; dimensions: number; count: number }>;
}): string {
  const lines: string[] = [];
  lines.push(`── ${label} ──`);
  lines.push(`  current: ${s.current.provider}:${s.current.model}:${s.current.dimensions}`);
  lines.push(`  total embeddings: ${s.total}`);
  lines.push(`  matched:    ${s.matched}`);
  lines.push(`  mismatched: ${s.mismatched}`);
  lines.push(`  legacy:     ${s.legacy}  (pre-tagging rows; treated as needing re-embed)`);
  lines.push(`  missing:    ${s.missing} (active chunks with no embedding row)`);
  lines.push(`  by producer:`);
  for (const b of s.byProducer) {
    const tag = b.provider === "" ? "(legacy)" : `${b.provider}/${b.model || "(no model)"}`;
    lines.push(`    ${tag} dim=${b.dimensions} count=${b.count}`);
  }
  return lines.join("\n");
}

export async function runReembed(opts: CliOpts): Promise<{ processed: number; failed: number; planned: number }> {
  const log = makeLog();
  const pluginCfg = loadPluginConfig(opts.configPath);
  const stateDir = path.join(os.homedir(), ".openclaw");
  const resolved = resolveConfig(pluginCfg, stateDir);
  const dbPath = opts.dbPath ?? resolved.storage!.dbPath!;
  log.info(`config:  ${opts.configPath}`);
  log.info(`db:      ${dbPath}`);

  const store = new SqliteStore(dbPath, log);
  const embedder = new Embedder(resolved.embedding, log);
  const producer = { provider: embedder.provider, model: embedder.model };
  const current = { provider: embedder.provider, model: embedder.model, dimensions: embedder.dimensions };

  const before = store.getEmbeddingStats(current);
  console.log(formatStats("before", before));

  const ids = store.listChunkIdsForReembed(current, {
    missingOnly: opts.missingOnly,
    limit: opts.limit,
  });
  console.log(`\nplanned re-embed: ${ids.length} chunk(s)`);

  if (opts.dryRun) {
    console.log("(dry-run: no writes performed)");
    store.close();
    return { processed: 0, failed: 0, planned: ids.length };
  }

  let processed = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += opts.batchSize) {
    const batchIds = ids.slice(i, i + opts.batchSize);
    const texts: string[] = [];
    const keep: string[] = [];
    for (const id of batchIds) {
      const chunk = store.getChunk(id);
      if (!chunk) continue;
      const text = chunk.summary || (chunk.content ?? "").slice(0, 500);
      if (!text) continue;
      keep.push(id);
      texts.push(text);
    }
    if (keep.length === 0) continue;

    try {
      const vecs = await embedder.embed(texts);
      for (let j = 0; j < keep.length; j++) {
        if (vecs[j]) {
          store.upsertEmbedding(keep[j], vecs[j], producer);
          processed++;
        }
      }
      console.log(`  batch ${i / opts.batchSize + 1}: re-embedded ${keep.length} chunk(s) (cumulative ${processed}/${ids.length})`);
    } catch (err) {
      failed += keep.length;
      log.warn(`batch ${i / opts.batchSize + 1} failed; continuing: ${err}`);
    }
  }

  const after = store.getEmbeddingStats(current);
  console.log("\n" + formatStats("after", after));
  console.log(`\ndone: processed=${processed} failed=${failed} planned=${ids.length}`);

  store.close();
  return { processed, failed, planned: ids.length };
}

async function main(): Promise<void> {
  let opts: CliOpts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err));
    console.error(HELP);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const result = await runReembed(opts);
  if (result.failed > 0) process.exitCode = 1;
}

// Node will run main() when invoked directly. We avoid the `import.meta.url`
// trick for vitest compatibility and just check require.main or treat any
// direct script execution as the entry point.
const isDirect = (() => {
  try {
    // tsx + ESM: process.argv[1] is the script path
    return process.argv[1] && process.argv[1].endsWith("re-embed.ts");
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    console.error("re-embed failed:", err);
    process.exit(1);
  });
}
