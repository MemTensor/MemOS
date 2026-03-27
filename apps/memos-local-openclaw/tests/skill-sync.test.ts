import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { buildSkillBundleForHub } from "../src/client/skill-sync";
import type { Logger, Skill, SkillVersion } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let tmpDir: string;
let store: SqliteStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-skill-sync-"));
  store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const now = Date.now();
  return {
    id: overrides.id ?? "skill-1",
    name: overrides.name ?? "docker-compose-deploy",
    description: overrides.description ?? "Deploy with docker compose",
    version: overrides.version ?? 2,
    status: overrides.status ?? "active",
    tags: overrides.tags ?? JSON.stringify(["docker", "deploy"]),
    sourceType: overrides.sourceType ?? "manual",
    dirPath: overrides.dirPath ?? path.join(tmpDir, "skill-dir"),
    installed: overrides.installed ?? 0,
    owner: overrides.owner ?? "agent:main",
    visibility: overrides.visibility ?? "private",
    qualityScore: overrides.qualityScore ?? 0.88,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeVersion(skillId: string, overrides: Partial<SkillVersion> = {}): SkillVersion {
  const now = Date.now();
  return {
    id: overrides.id ?? "skill-version-1",
    skillId,
    version: overrides.version ?? 2,
    content: overrides.content ?? "# Docker Compose Deploy\nUse docker compose up -d",
    changelog: overrides.changelog ?? "Improve deployment flow",
    changeSummary: overrides.changeSummary ?? "Added scripts and evals",
    upgradeType: overrides.upgradeType ?? "refine",
    sourceTaskId: overrides.sourceTaskId ?? null,
    metrics: overrides.metrics ?? "{}",
    qualityScore: overrides.qualityScore ?? 0.88,
    createdAt: overrides.createdAt ?? now,
  };
}

describe("buildSkillBundleForHub", () => {
  it("packages SKILL.md, scripts, references, and evals from a local skill directory", () => {
    const skill = makeSkill();
    fs.mkdirSync(skill.dirPath, { recursive: true });
    fs.writeFileSync(path.join(skill.dirPath, "SKILL.md"), "# Docker Compose Deploy\nSee scripts/deploy.sh", "utf8");
    fs.mkdirSync(path.join(skill.dirPath, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skill.dirPath, "scripts", "deploy.sh"), "#!/bin/bash\ndocker compose up -d\n", "utf8");
    fs.mkdirSync(path.join(skill.dirPath, "references"), { recursive: true });
    fs.writeFileSync(path.join(skill.dirPath, "references", "docker-compose.yml"), "services:\n  app: {}\n", "utf8");
    fs.mkdirSync(path.join(skill.dirPath, "evals"), { recursive: true });
    fs.writeFileSync(
      path.join(skill.dirPath, "evals", "evals.json"),
      JSON.stringify({
        skill_name: skill.name,
        evals: [{ id: 1, prompt: "deploy app", expectations: ["compose", "up -d"] }],
      }),
      "utf8",
    );

    store.insertSkill(skill);
    store.insertSkillVersion(makeVersion(skill.id));

    const bundle = buildSkillBundleForHub(store, skill.id);

    expect(bundle.metadata.id).toBe(skill.id);
    expect(bundle.metadata.name).toBe(skill.name);
    expect(bundle.metadata.version).toBe(skill.version);
    expect(bundle.bundle.skill_md).toContain("Docker Compose Deploy");
    expect(bundle.bundle.scripts).toEqual([
      expect.objectContaining({ filename: "deploy.sh" }),
    ]);
    expect(bundle.bundle.references).toEqual([
      expect.objectContaining({ filename: "docker-compose.yml" }),
    ]);
    expect(bundle.bundle.evals).toEqual([
      expect.objectContaining({ id: 1, prompt: "deploy app" }),
    ]);
  });

  it("falls back to the latest skill version content when SKILL.md is missing", () => {
    const skill = makeSkill({ id: "skill-2", dirPath: path.join(tmpDir, "skill-dir-2") });
    fs.mkdirSync(skill.dirPath, { recursive: true });
    store.insertSkill(skill);
    store.insertSkillVersion(makeVersion(skill.id, { content: "# Version Fallback\nRecovered from DB" }));

    const bundle = buildSkillBundleForHub(store, skill.id);

    expect(bundle.bundle.skill_md).toContain("Version Fallback");
    expect(bundle.bundle.scripts).toEqual([]);
    expect(bundle.bundle.references).toEqual([]);
    expect(bundle.bundle.evals).toEqual([]);
  });
});
