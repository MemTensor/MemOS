import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { SkillEvolver } from "../src/skill/evolver";
import { RecallEngine } from "../src/recall/engine";
import type { Logger, PluginContext, MemosLocalConfig, Task } from "../src/types";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let tmpDir: string;
let store: SqliteStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-autoinstall-"));
  const dbPath = path.join(tmpDir, "memos.db");
  store = new SqliteStore(dbPath, noopLog);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SkillEvolver autoInstall behavior", () => {
  it("should NOT auto-install install_recommended skills when autoInstall=false", async () => {
    const ctx: PluginContext = {
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      config: {
        skillEvolution: {
          enabled: true,
          autoInstall: false,
          autoEvaluate: false,
        },
      } as MemosLocalConfig,
      log: noopLog,
    };

    // Create a skill with install_recommended characteristics (3+ scripts)
    const skillDir = path.join(tmpDir, "skills-repo", "deploy-automation");
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });

    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "deploy-automation"
description: "Automated deployment scripts"
version: 1
---

## Steps
1. Run deploy scripts
`, "utf-8");

    // Create 3 scripts to trigger install_recommended
    fs.writeFileSync(path.join(scriptsDir, "deploy.sh"), "#!/bin/bash\necho deploy", "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "rollback.sh"), "#!/bin/bash\necho rollback", "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "health-check.sh"), "#!/bin/bash\necho check", "utf-8");

    const skillId = "deploy-automation-001";
    store.insertSkill({
      id: skillId,
      name: "deploy-automation",
      description: "Automated deployment",
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

    const engine = new RecallEngine(store, ctx);
    const evolver = new SkillEvolver(store, engine, ctx);

    // Trigger the private autoInstallIfNeeded through reflection
    const skill = store.getSkill(skillId);
    expect(skill).not.toBeNull();

    // Use type assertion to access private method for testing
    (evolver as any).autoInstallIfNeeded(skill);

    // Verify the skill was NOT installed
    const updatedSkill = store.getSkill(skillId);
    expect(updatedSkill?.installed).toBe(0);

    const workspaceSkillDir = path.join(tmpDir, "skills", "deploy-automation");
    expect(fs.existsSync(workspaceSkillDir)).toBe(false);
  });

  it("should auto-install install_recommended skills when autoInstall=true", async () => {
    const ctx: PluginContext = {
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      config: {
        skillEvolution: {
          enabled: true,
          autoInstall: true,
          autoEvaluate: false,
        },
      } as MemosLocalConfig,
      log: noopLog,
    };

    // Create a skill with install_recommended characteristics
    const skillDir = path.join(tmpDir, "skills-repo", "build-tools");
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });

    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "build-tools"
description: "Build automation tools"
version: 1
---

## Steps
1. Run build scripts
`, "utf-8");

    // Create 3 scripts to trigger install_recommended
    fs.writeFileSync(path.join(scriptsDir, "build.sh"), "#!/bin/bash\necho build", "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "test.sh"), "#!/bin/bash\necho test", "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "package.sh"), "#!/bin/bash\necho package", "utf-8");

    const skillId = "build-tools-001";
    store.insertSkill({
      id: skillId,
      name: "build-tools",
      description: "Build automation",
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

    const engine = new RecallEngine(store, ctx);
    const evolver = new SkillEvolver(store, engine, ctx);

    const skill = store.getSkill(skillId);
    expect(skill).not.toBeNull();

    // Use type assertion to access private method for testing
    (evolver as any).autoInstallIfNeeded(skill);

    // Verify the skill WAS installed
    const updatedSkill = store.getSkill(skillId);
    expect(updatedSkill?.installed).toBe(1);

    const workspaceSkillDir = path.join(tmpDir, "skills", "build-tools");
    expect(fs.existsSync(workspaceSkillDir)).toBe(true);
    expect(fs.existsSync(path.join(workspaceSkillDir, "scripts", "build.sh"))).toBe(true);
  });

  it("should respect default autoInstall=true when config is not specified", async () => {
    const ctx: PluginContext = {
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      config: {
        skillEvolution: {
          enabled: true,
          // autoInstall not specified, should default to true
        },
      } as MemosLocalConfig,
      log: noopLog,
    };

    const skillDir = path.join(tmpDir, "skills-repo", "default-test");
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });

    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "default-test"
description: "Test default behavior"
version: 1
---

## Steps
1. Test
`, "utf-8");

    fs.writeFileSync(path.join(scriptsDir, "script1.sh"), "#!/bin/bash\necho 1", "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "script2.sh"), "#!/bin/bash\necho 2", "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "script3.sh"), "#!/bin/bash\necho 3", "utf-8");

    const skillId = "default-test-001";
    store.insertSkill({
      id: skillId,
      name: "default-test",
      description: "Default test",
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

    const engine = new RecallEngine(store, ctx);
    const evolver = new SkillEvolver(store, engine, ctx);

    const skill = store.getSkill(skillId);
    (evolver as any).autoInstallIfNeeded(skill);

    // Should be installed by default
    const updatedSkill = store.getSkill(skillId);
    expect(updatedSkill?.installed).toBe(1);
  });
});
