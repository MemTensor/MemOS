import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { migrateDshPresetProfile } from "../../../scripts/migrate-dsh-preset-profile.mjs";

let handle: TmpDbHandle;
beforeEach(() => {
  handle = makeTmpDb({ agent: "deepseek-harness" });
  const meta = JSON.stringify({
    namespace: {
      agentKind: "deepseek-harness",
      profileId: "standard",
      profileLabel: "standard",
    },
    ownerProfileId: "standard",
  });
  handle.db
    .prepare(
      "INSERT INTO sessions(id,agent,owner_agent_kind,owner_profile_id,started_at,last_seen_at,meta_json) VALUES('s','deepseek-harness','deepseek-harness','standard',1,1,?)",
    )
    .run(meta);
  handle.db.exec(
    "INSERT INTO episodes(id,session_id,owner_agent_kind,owner_profile_id,started_at) VALUES('e','s','deepseek-harness','standard',1)",
  );
  handle.db.exec(
    "INSERT INTO traces(id,session_id,episode_id,owner_agent_kind,owner_profile_id,ts,user_text,agent_text,turn_id,vec_summary) VALUES('t','s','e','deepseek-harness','standard',1,'Synthetic migration','Synthetic answer',1,X'0000803F')",
  );
  handle.db.exec(
    "INSERT INTO sessions(id,agent,owner_agent_kind,owner_profile_id,started_at,last_seen_at) VALUES('other','deepseek-harness','deepseek-harness','work',1,1),('other-agent','hermes','hermes','standard',1,1)",
  );
});
afterEach(() => handle.cleanup());
const options = () => ({
  dbPath: handle.filepath,
  from: "standard",
  to: "default",
});

describe("explicit migration of legacy DSH preset ownership", () => {
  it("defaults to a read-only preview and never merges other profiles", async () => {
    const result = await migrateDshPresetProfile(options());
    expect(result).toMatchObject({
      dryRun: true,
      counts: { traces: 1, sessions: 1, episodes: 1 },
    });
    expect(
      handle.db.prepare("SELECT owner_profile_id FROM traces").get(),
    ).toEqual({ owner_profile_id: "standard" });
  });

  it("backs up first and atomically preserves IDs, vectors, sharing and namespace metadata", async () => {
    const backupPath = path.join(handle.dir, "before.db");
    const result = await migrateDshPresetProfile({
      ...options(),
      apply: true,
      backupPath,
    });
    expect(result).toMatchObject({ dryRun: false, backupPath });
    const saved = new Database(backupPath, { readonly: true });
    try {
      expect(
        saved.prepare("SELECT owner_profile_id FROM traces").get(),
      ).toEqual({ owner_profile_id: "standard" });
    } finally {
      saved.close();
    }
    expect(
      handle.db
        .prepare(
          "SELECT id,owner_profile_id,hex(vec_summary) AS vec,share_scope FROM traces",
        )
        .get(),
    ).toEqual({
      id: "t",
      owner_profile_id: "default",
      vec: "0000803F",
      share_scope: "private",
    });
    const session = handle.db
      .prepare("SELECT meta_json FROM sessions WHERE id='s'")
      .get() as { meta_json: string };
    expect(JSON.parse(session.meta_json)).toMatchObject({
      ownerProfileId: "default",
      namespace: { profileId: "default" },
    });
    expect(
      handle.db
        .prepare("SELECT owner_profile_id FROM sessions WHERE id='other'")
        .get(),
    ).toEqual({ owner_profile_id: "work" });
    expect(
      handle.db
        .prepare("SELECT owner_profile_id FROM sessions WHERE id='other-agent'")
        .get(),
    ).toEqual({ owner_profile_id: "standard" });
  });

  it("rolls back all ownership updates on a conflicting skill name", async () => {
    handle.db.exec(
      "INSERT INTO skills(id,owner_agent_kind,owner_profile_id,name,invocation_guide,created_at,updated_at) VALUES('a','deepseek-harness','standard','synthetic','guide',1,1),('b','deepseek-harness','default','synthetic','guide',1,1)",
    );
    const backupPath = path.join(handle.dir, "before.db");
    await expect(
      migrateDshPresetProfile({ ...options(), apply: true, backupPath }),
    ).rejects.toThrow();
    expect(
      handle.db.prepare("SELECT owner_profile_id FROM episodes").get(),
    ).toEqual({ owner_profile_id: "standard" });
    expect(
      handle.db.prepare("SELECT owner_profile_id FROM traces").get(),
    ).toEqual({ owner_profile_id: "standard" });
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it("requires a new backup path before applying changes", async () => {
    await expect(
      migrateDshPresetProfile({ ...options(), apply: true }),
    ).rejects.toThrow(/backup/i);
    const backupPath = path.join(handle.dir, "protected.db");
    fs.writeFileSync(backupPath, "keep");
    await expect(
      migrateDshPresetProfile({ ...options(), apply: true, backupPath }),
    ).rejects.toThrow();
    expect(fs.readFileSync(backupPath, "utf8")).toBe("keep");
    await expect(
      migrateDshPresetProfile({
        ...options(),
        apply: true,
        backupPath: handle.filepath,
      }),
    ).rejects.toThrow();
  });
});
