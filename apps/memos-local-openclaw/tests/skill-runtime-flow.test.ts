import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { SkillInstaller, type SkillCompanionManifest } from "../src/skill/installer";
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

function createSkillDir(name: string, opts?: {
  scripts?: Array<{ name: string; content: string }>;
  references?: Array<{ name: string; content: string }>;
  evals?: object;
}): string {
  const skillDir = path.join(tmpDir, "skills-store", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: "${name}"
description: "Test skill for ${name}"
version: 1
---

## Steps
1. Do something
`, "utf-8");

  if (opts?.scripts) {
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const s of opts.scripts) {
      fs.writeFileSync(path.join(scriptsDir, s.name), s.content, "utf-8");
    }
  }
  if (opts?.references) {
    const refsDir = path.join(skillDir, "references");
    fs.mkdirSync(refsDir, { recursive: true });
    for (const r of opts.references) {
      fs.writeFileSync(path.join(refsDir, r.name), r.content, "utf-8");
    }
  }
  if (opts?.evals) {
    const evalsDir = path.join(skillDir, "evals");
    fs.mkdirSync(evalsDir, { recursive: true });
    fs.writeFileSync(path.join(evalsDir, "evals.json"), JSON.stringify(opts.evals), "utf-8");
  }
  return skillDir;
}

function insertSkillRecord(id: string, name: string, dirPath: string): void {
  store.insertSkill({
    id,
    name,
    description: `Test skill ${name}`,
    version: 1,
    status: "active",
    tags: "",
    sourceType: "task",
    dirPath,
    installed: 0,
    owner: "agent:main",
    visibility: "private",
    qualityScore: 8,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-skill-flow-"));
  const dbPath = path.join(tmpDir, "memos.db");
  store = new SqliteStore(dbPath, noopLog);
  ctx = {
    stateDir: tmpDir,
    workspaceDir: tmpDir,
    config: {} as MemosLocalConfig,
    log: noopLog,
  };
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Level 1: Pure document skill (inline) ───

describe("Level 1: pure doc skill (inline mode)", () => {
  it("should classify a SKILL.md-only skill as inline", () => {
    const skillDir = createSkillDir("pure-doc");
    insertSkillRecord("pure-1", "pure-doc", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const manifest = installer.getCompanionManifest("pure-1");

    expect(manifest).not.toBeNull();
    expect(manifest!.hasCompanionFiles).toBe(false);
    expect(manifest!.installMode).toBe("inline");
    expect(manifest!.files.length).toBe(0);
    expect(manifest!.scriptsCount).toBe(0);
    expect(manifest!.referencesCount).toBe(0);
  });

  it("should not consider evals-only as companion files", () => {
    const skillDir = createSkillDir("evals-only", {
      evals: { skill_name: "evals-only", evals: [{ id: 1, prompt: "test" }] },
    });
    insertSkillRecord("evals-1", "evals-only", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const manifest = installer.getCompanionManifest("evals-1");

    expect(manifest!.hasCompanionFiles).toBe(false);
    expect(manifest!.installMode).toBe("inline");
    expect(manifest!.evalsCount).toBe(1);
  });
});

// ─── Level 2: On-demand companion files ───

describe("Level 2: on_demand companion files", () => {
  it("should classify a skill with small scripts as on_demand", () => {
    const skillDir = createSkillDir("small-scripts", {
      scripts: [
        { name: "deploy.sh", content: "#!/bin/bash\necho hello" },
      ],
      references: [
        { name: "notes.md", content: "# Notes\nSome reference." },
      ],
    });
    insertSkillRecord("small-1", "small-scripts", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const manifest = installer.getCompanionManifest("small-1");

    expect(manifest!.hasCompanionFiles).toBe(true);
    expect(manifest!.installMode).toBe("on_demand");
    expect(manifest!.scriptsCount).toBe(1);
    expect(manifest!.referencesCount).toBe(1);
  });

  it("should be able to read companion file content without installing", () => {
    const scriptContent = "#!/bin/bash\nset -e\nnpm run build\nnpm run deploy";
    const skillDir = createSkillDir("readable-scripts", {
      scripts: [{ name: "deploy.sh", content: scriptContent }],
    });
    insertSkillRecord("read-1", "readable-scripts", skillDir);

    const installer = new SkillInstaller(store, ctx);

    const result = installer.readCompanionFile("read-1", "scripts/deploy.sh");
    expect("content" in result).toBe(true);
    if ("content" in result) {
      expect(result.content).toBe(scriptContent);
      expect(result.size).toBe(scriptContent.length);
    }
  });

  it("should reject path traversal attempts", () => {
    const skillDir = createSkillDir("path-traversal");
    insertSkillRecord("trav-1", "path-traversal", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const result = installer.readCompanionFile("trav-1", "../../etc/passwd");
    expect("error" in result).toBe(true);
  });

  it("should return error for non-existent companion file", () => {
    const skillDir = createSkillDir("no-file");
    insertSkillRecord("nofile-1", "no-file", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const result = installer.readCompanionFile("nofile-1", "scripts/missing.sh");
    expect("error" in result).toBe(true);
  });
});

// ─── Level 3: Install recommended ───

describe("Level 3: install_recommended (large/complex skill)", () => {
  it("should classify a skill with many scripts as install_recommended", () => {
    const largeContent = "x".repeat(8000);
    const skillDir = createSkillDir("many-scripts", {
      scripts: [
        { name: "build.sh", content: largeContent },
        { name: "deploy.sh", content: largeContent },
        { name: "test.sh", content: largeContent },
      ],
    });
    insertSkillRecord("many-1", "many-scripts", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const manifest = installer.getCompanionManifest("many-1");

    expect(manifest!.hasCompanionFiles).toBe(true);
    expect(manifest!.installMode).toBe("install_recommended");
    expect(manifest!.scriptsCount).toBe(3);
  });

  it("should classify a skill with large total size as install_recommended", () => {
    const skillDir = createSkillDir("large-skill", {
      scripts: [
        { name: "main.py", content: "x".repeat(12000) },
      ],
      references: [
        { name: "api-docs.md", content: "x".repeat(10000) },
      ],
    });
    insertSkillRecord("large-1", "large-skill", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const manifest = installer.getCompanionManifest("large-1");

    expect(manifest!.hasCompanionFiles).toBe(true);
    expect(manifest!.installMode).toBe("install_recommended");
    expect(manifest!.totalSize).toBeGreaterThan(20000);
  });

  it("install should copy all companion files to workspace", () => {
    const skillDir = createSkillDir("install-test", {
      scripts: [{ name: "run.sh", content: "#!/bin/bash\necho run" }],
      references: [{ name: "arch.md", content: "# Architecture" }],
      evals: { skill_name: "install-test", evals: [] },
    });
    insertSkillRecord("inst-1", "install-test", skillDir);

    const installer = new SkillInstaller(store, ctx);
    const result = installer.install("inst-1");

    expect(result.installed).toBe(true);

    const dstDir = path.join(tmpDir, "skills", "install-test");
    expect(fs.existsSync(path.join(dstDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, "scripts", "run.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, "references", "arch.md"))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, "evals", "evals.json"))).toBe(true);
  });

  it("installed manifest should reflect installed state", () => {
    const skillDir = createSkillDir("manifest-installed", {
      scripts: [{ name: "deploy.sh", content: "echo deploy" }],
    });
    insertSkillRecord("manif-1", "manifest-installed", skillDir);

    const installer = new SkillInstaller(store, ctx);
    installer.install("manif-1");

    const manifest = installer.getCompanionManifest("manif-1");
    expect(manifest!.installed).toBe(true);
    expect(manifest!.installedPath).toContain("manifest-installed");
  });
});

// ─── Manifest classification rules ───

describe("buildManifest classification", () => {
  it("should handle missing skill directory gracefully", () => {
    const manifest = SkillInstaller.buildManifest("/nonexistent/path", false, "missing");
    expect(manifest.hasCompanionFiles).toBe(false);
    expect(manifest.installMode).toBe("inline");
    expect(manifest.files.length).toBe(0);
  });

  it("should count files correctly across types", () => {
    const skillDir = createSkillDir("count-test", {
      scripts: [
        { name: "a.sh", content: "echo a" },
        { name: "b.py", content: "print('b')" },
      ],
      references: [
        { name: "x.md", content: "# X" },
        { name: "y.md", content: "# Y" },
        { name: "z.md", content: "# Z" },
      ],
      evals: { evals: [{ id: 1 }] },
    });

    const manifest = SkillInstaller.buildManifest(skillDir, false, "count-test");
    expect(manifest.scriptsCount).toBe(2);
    expect(manifest.referencesCount).toBe(3);
    expect(manifest.evalsCount).toBe(1);
    expect(manifest.files.length).toBe(6);
  });
});
