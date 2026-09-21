import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { backfillLegacyPolicyMetadata } from "../../../core/storage/policy-metadata-backfill.js";
import { openDb, runMigrations } from "../../../core/storage/index.js";

describe("policy metadata backfill", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("backfills old rows in bounded, idempotent batches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-meta-"));
    const dbPath = path.join(dir, "m.db");
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb({ filepath: dbPath, agent: "openclaw" });
    try {
      runMigrations(db);
      db.exec(`
        INSERT INTO sessions (id, agent, started_at, last_seen_at) VALUES ('s1', 'openclaw', 1, 1);
        INSERT INTO episodes (id, session_id, started_at) VALUES ('e1', 's1', 1);
        INSERT INTO traces (id, episode_id, session_id, ts, user_text, agent_text, reflection, tool_calls_json, tags_json, turn_id)
          VALUES ('t1', 'e1', 's1', 1, '请修复部署', '部署失败 DEPLOY_TIMEOUT', '重试服务',
                  '[{"name":"kubectl","input":"{\\"code\\":1}"}]', '["k8s","部署"]', 1);
        INSERT INTO policies (id, title, trigger, procedure, verification, boundary, source_trace_ids_json, created_at, updated_at)
          VALUES ('p1', 'legacy policy', 'trigger', 'procedure', 'verify', 'boundary', '["t1"]', 1, 1);
      `);

      const replay = runMigrations(db);
      expect(replay.metadataBackfilled).toBe(1);
      const row = db.prepare<{ id: string }, { metadata_json: string | null }>(
        `SELECT metadata_json FROM policies WHERE id=@id`,
      ).get({ id: "p1" });
      expect(JSON.parse(row!.metadata_json!)).toMatchObject({
        version: 1,
        language: "mixed",
        domainTags: ["k8s", "部署"],
        toolNames: ["kubectl"],
        errorCodes: ["DEPLOY_TIMEOUT"],
      });
      expect(backfillLegacyPolicyMetadata(db, { batchSize: 1 })).toBe(0);
    } finally {
      db.close();
    }
  });
});
