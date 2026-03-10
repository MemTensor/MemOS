/**
 * Standalone Viewer launcher — starts the Memory Viewer web UI
 * without needing the full OpenClaw plugin lifecycle.
 *
 * Usage:
 *   npx tsx scripts/start-viewer.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { SqliteStore } from "../src/storage/sqlite";
import { Embedder } from "../src/embedding";
import { ViewerServer } from "../src/viewer/server";
import { buildContext } from "../src/config";
import type { Logger } from "../src/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
}

const log: Logger = {
  info: (msg: string) => console.log(`\x1b[36m  ℹ ${msg}\x1b[0m`),
  warn: (msg: string) => console.log(`\x1b[33m  ⚠ ${msg}\x1b[0m`),
  error: (msg: string) => console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`),
  debug: (msg: string) => console.log(`\x1b[90m  · ${msg}\x1b[0m`),
};

async function main() {
  const dataDir = path.join(os.homedir(), ".memos-local");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "memos.db");
  log.info(`Database: ${dbPath}`);

  const store = new SqliteStore(dbPath, log);

  const embedder = new Embedder(
    {
      provider: "openai_compatible" as any,
      endpoint: process.env.EMBEDDING_ENDPOINT,
      apiKey: process.env.EMBEDDING_API_KEY,
      model: process.env.EMBEDDING_MODEL ?? "bge-m3",
    },
    log,
  );

  const port = parseInt(process.env.VIEWER_PORT ?? "18799", 10);
  const ctx = buildContext(dataDir, process.cwd(), undefined, log);
  const viewer = new ViewerServer({ store, embedder, port, log, dataDir, ctx });

  const url = await viewer.start();
  console.log();
  console.log(`\x1b[1m╔══════════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[1m║  🧠 MemOS Memory Viewer                  ║\x1b[0m`);
  console.log(`\x1b[1m║  → \x1b[36m${url.padEnd(37)}\x1b[0m\x1b[1m║\x1b[0m`);
  console.log(`\x1b[1m║  Open in browser to manage memories       ║\x1b[0m`);
  console.log(`\x1b[1m╚══════════════════════════════════════════╝\x1b[0m`);
  console.log();
  console.log(`\x1b[90m  Reset token: ${viewer.getResetToken()}\x1b[0m`);
  console.log(`\x1b[90m  Press Ctrl+C to stop\x1b[0m`);

  process.on("SIGINT", () => {
    viewer.stop();
    store.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start viewer:", err);
  process.exit(1);
});
