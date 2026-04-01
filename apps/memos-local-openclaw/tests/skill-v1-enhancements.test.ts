import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { SkillInstaller } from "../src/skill/installer";
import { SkillValidator, ValidationResult } from "../src/skill/validator";
import { SkillGenerator } from "../src/skill/generator";
import type { Logger, PluginContext, MemosLocalConfig } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let tmpDir: string;
let store: SqliteStore;
let ctx: PluginContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-skill-v1-"));
  const dbPath = path.join(tmpDir, "memos.db");
  store = new SqliteStore(dbPath, noopLog);
  ctx = {
    stateDir: tmpDir,
    workspaceDir: tmpDir,
    config: {
      skillEvolution: { redactSensitiveInSkill: true },
    } as MemosLocalConfig,
    log: noopLog,
  };
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Installer: clean sync ───

describe("SkillInstaller clean sync", () => {
  it("should remove old files when reinstalling a skill", () => {
    const skillDir = path.join(tmpDir, "skill-source", "test-skill");
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "test-skill"
description: "A test skill for clean sync"
version: 1
---

## Steps
1. Do something
`, "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "deploy.sh"), "#!/bin/bash\necho deploy", "utf-8");

    const skillId = "test-skill-id-001";
    store.insertSkill({
      id: skillId,
      name: "test-skill",
      description: "A test skill",
      version: 1,
      status: "active",
      tags: "",
      sourceType: "task",
      dirPath: skillDir,
      installed: 0,
      owner: "agent:main",
      visibility: "private",
      qualityScore: 8,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const installer = new SkillInstaller(store, ctx);
    const result = installer.install(skillId);
    expect(result.installed).toBe(true);

    const dstDir = path.join(tmpDir, "skills", "test-skill");
    expect(fs.existsSync(path.join(dstDir, "scripts", "deploy.sh"))).toBe(true);

    // Now update the source: remove deploy.sh, add new.sh
    fs.unlinkSync(path.join(scriptsDir, "deploy.sh"));
    fs.writeFileSync(path.join(scriptsDir, "new.sh"), "#!/bin/bash\necho new", "utf-8");

    // Sync should do clean install
    installer.syncIfInstalled("test-skill");

    expect(fs.existsSync(path.join(dstDir, "scripts", "new.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, "scripts", "deploy.sh"))).toBe(false);
  });
});

// ─── Validator: companion consistency ───

describe("SkillValidator companion checks", () => {
  it("should warn about missing referenced scripts", async () => {
    const skillDir = path.join(tmpDir, "skill-validate");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "deploy-helper"
description: "Helps with deployment tasks"
version: 1
---

## Steps
1. Run \`scripts/deploy.sh\` to deploy
2. Check \`scripts/verify.sh\` for health
3. See \`references/arch.md\` for architecture
`, "utf-8");

    const validator = new SkillValidator(ctx);
    const result = await validator.validate(skillDir, { skipLLM: true });

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("scripts/deploy.sh") && w.includes("does not exist"))).toBe(true);
    expect(result.warnings.some(w => w.includes("scripts/verify.sh") && w.includes("does not exist"))).toBe(true);
    expect(result.warnings.some(w => w.includes("references/arch.md") && w.includes("does not exist"))).toBe(true);
  });

  it("should warn about orphaned scripts not referenced in SKILL.md", async () => {
    const skillDir = path.join(tmpDir, "skill-orphan");
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "orphan-test"
description: "Test orphaned file detection"
version: 1
---

## Steps
1. Do something without scripts.
This skill has no script references in SKILL.md.
`, "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "old-deploy.sh"), "#!/bin/bash\necho old", "utf-8");

    const validator = new SkillValidator(ctx);
    const result = await validator.validate(skillDir, { skipLLM: true });

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("old-deploy.sh") && w.includes("not referenced"))).toBe(true);
  });

  it("should warn about invalid evals.json structure", async () => {
    const skillDir = path.join(tmpDir, "skill-bad-evals");
    const evalsDir = path.join(skillDir, "evals");
    fs.mkdirSync(evalsDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "evals-test"
description: "Test evals validation"
version: 1
---

## Steps
1. Test something
`, "utf-8");
    fs.writeFileSync(path.join(evalsDir, "evals.json"), "this is not json", "utf-8");

    const validator = new SkillValidator(ctx);
    const result = await validator.validate(skillDir, { skipLLM: true });

    expect(result.warnings.some(w => w.includes("evals.json") && w.includes("not valid JSON"))).toBe(true);
  });
});

// ─── Validator: secret scanning ───

describe("SkillValidator secret scanning", () => {
  it("should detect API keys in SKILL.md", async () => {
    const skillDir = path.join(tmpDir, "skill-secret");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "secret-test"
description: "Test secret detection"
version: 1
---

## Configuration
Set your API key:
api_key="sk-abcdef1234567890abcdefghij"
`, "utf-8");

    const validator = new SkillValidator(ctx);
    const result = await validator.validate(skillDir, { skipLLM: true });

    expect(result.warnings.some(w => w.includes("secret") || w.includes("API key"))).toBe(true);
  });

  it("should detect secrets in scripts directory", async () => {
    const skillDir = path.join(tmpDir, "skill-script-secret");
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "script-secret"
description: "Test script secret detection"
version: 1
---

## Steps
1. Run deploy
`, "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "deploy.sh"), `#!/bin/bash
export TOKEN="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.12345678901234567890"
`, "utf-8");

    const validator = new SkillValidator(ctx);
    const result = await validator.validate(skillDir, { skipLLM: true });

    expect(result.warnings.some(w => w.includes("secret") || w.includes("Bearer") || w.includes("token"))).toBe(true);
  });
});

// ─── Generator: redaction ───

describe("SkillGenerator redactSensitive", () => {
  it("should redact OpenAI API keys", () => {
    const input = "Use api key sk-abcdef1234567890abcdefghij for testing";
    const result = SkillGenerator.redactSensitive(input);
    expect(result).not.toContain("sk-abcdef1234567890abcdefghij");
    expect(result).toContain("sk-***REDACTED***");
  });

  it("should redact Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.123456789012345678";
    const result = SkillGenerator.redactSensitive(input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("Bearer ***REDACTED***");
  });

  it("should redact AWS access key IDs", () => {
    const input = "AWS key: AKIAIOSFODNN7EXAMPLE";
    const result = SkillGenerator.redactSensitive(input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("AKIA***REDACTED***");
  });

  it("should redact user paths", () => {
    const input = "File at /Users/johndoe/projects/secret";
    const result = SkillGenerator.redactSensitive(input);
    expect(result).not.toContain("johndoe");
    expect(result).toContain("/Users/****/");
  });

  it("should redact generic secrets in assignments", () => {
    const input = `config.api_key="my-super-secret-key-123"`;
    const result = SkillGenerator.redactSensitive(input);
    expect(result).not.toContain("my-super-secret-key-123");
    expect(result).toContain("***REDACTED***");
  });

  it("should not alter text without secrets", () => {
    const input = "This is a normal text about deploying a React app with npm.";
    const result = SkillGenerator.redactSensitive(input);
    expect(result).toBe(input);
  });
});

// ─── Config defaults ───

describe("Skill config defaults", () => {
  it("should have correct default values from DEFAULTS", async () => {
    const { DEFAULTS } = await import("../src/types");
    expect(DEFAULTS.skillAutoRecall).toBe(true);
    expect(DEFAULTS.skillAutoRecallLimit).toBe(2);
    expect(DEFAULTS.skillPreferUpgrade).toBe(true);
    expect(DEFAULTS.skillRedactSensitive).toBe(true);
  });
});
