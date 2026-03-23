import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "../storage/sqlite";
import type { PluginContext } from "../types";

export type SkillInstallMode = "inline" | "on_demand" | "install_recommended";

export interface CompanionFileInfo {
  relativePath: string;
  size: number;
  type: "script" | "reference" | "eval" | "other";
}

export interface SkillCompanionManifest {
  hasCompanionFiles: boolean;
  installMode: SkillInstallMode;
  installed: boolean;
  installedPath?: string;
  files: CompanionFileInfo[];
  totalSize: number;
  scriptsCount: number;
  referencesCount: number;
  evalsCount: number;
}

export class SkillInstaller {
  private workspaceSkillsDir: string;

  constructor(
    private store: SqliteStore,
    private ctx: PluginContext,
  ) {
    this.workspaceSkillsDir = path.join(ctx.workspaceDir, "skills");
  }

  getCompanionManifest(skillId: string): SkillCompanionManifest | null {
    const skill = this.store.getSkill(skillId);
    if (!skill) return null;
    return SkillInstaller.buildManifest(skill.dirPath, !!skill.installed, skill.name, this.workspaceSkillsDir);
  }

  static buildManifest(dirPath: string, installed: boolean, skillName: string, workspaceSkillsDir?: string): SkillCompanionManifest {
    const files: CompanionFileInfo[] = [];

    const scanDir = (subDir: string, type: CompanionFileInfo["type"]) => {
      const fullDir = path.join(dirPath, subDir);
      if (!fs.existsSync(fullDir)) return;
      try {
        for (const f of fs.readdirSync(fullDir)) {
          const fp = path.join(fullDir, f);
          try {
            const stat = fs.statSync(fp);
            if (stat.isFile()) {
              files.push({ relativePath: `${subDir}/${f}`, size: stat.size, type });
            }
          } catch { /* best-effort */ }
        }
      } catch { /* best-effort */ }
    };

    scanDir("scripts", "script");
    scanDir("references", "reference");
    scanDir("evals", "eval");

    const scriptsCount = files.filter(f => f.type === "script").length;
    const referencesCount = files.filter(f => f.type === "reference").length;
    const evalsCount = files.filter(f => f.type === "eval").length;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const hasCompanionFiles = files.filter(f => f.type !== "eval").length > 0;

    let installMode: SkillInstallMode = "inline";
    if (hasCompanionFiles) {
      const executableScripts = files.filter(f => f.type === "script");
      const largeFiles = files.filter(f => f.size > 5000);
      if (executableScripts.length >= 3 || largeFiles.length >= 2 || totalSize > 20000) {
        installMode = "install_recommended";
      } else {
        installMode = "on_demand";
      }
    }

    const installedPath = installed && workspaceSkillsDir
      ? path.join(workspaceSkillsDir, skillName)
      : undefined;

    return { hasCompanionFiles, installMode, installed, installedPath, files, totalSize, scriptsCount, referencesCount, evalsCount };
  }

  readCompanionFile(skillId: string, relativePath: string): { content: string; size: number } | { error: string } {
    const skill = this.store.getSkill(skillId);
    if (!skill) return { error: "Skill not found" };

    const normalized = relativePath.replace(/\.\./g, "");
    const fullPath = path.join(skill.dirPath, normalized);

    if (!fullPath.startsWith(skill.dirPath)) {
      return { error: "Path traversal not allowed" };
    }

    if (!fs.existsSync(fullPath)) {
      return { error: `File not found: ${relativePath}` };
    }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      return { content, size: content.length };
    } catch (err) {
      return { error: `Cannot read file: ${err}` };
    }
  }

  install(skillId: string): { installed: boolean; path: string; message: string } {
    const skill = this.store.getSkill(skillId);
    if (!skill) return { installed: false, path: "", message: "Skill not found" };

    if (!fs.existsSync(skill.dirPath)) {
      return { installed: false, path: "", message: `Skill directory not found: ${skill.dirPath}` };
    }

    const dstDir = path.join(this.workspaceSkillsDir, skill.name);
    this.cleanSync(skill.dirPath, dstDir);
    this.store.updateSkill(skillId, { installed: 1 });

    this.ctx.log.info(`Skill installed: "${skill.name}" v${skill.version} → ${dstDir}`);
    return {
      installed: true,
      path: dstDir,
      message: `Skill "${skill.name}" v${skill.version} installed`,
    };
  }

  uninstall(skillId: string): void {
    const skill = this.store.getSkill(skillId);
    if (!skill) return;

    const dstDir = path.join(this.workspaceSkillsDir, skill.name);
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true });
    }
    this.store.updateSkill(skillId, { installed: 0 });
    this.ctx.log.info(`Skill uninstalled: "${skill.name}"`);
  }

  syncIfInstalled(skillName: string): void {
    const skill = this.store.getSkillByName(skillName);
    if (!skill || !skill.installed) return;

    const dstDir = path.join(this.workspaceSkillsDir, skill.name);
    if (fs.existsSync(skill.dirPath)) {
      this.cleanSync(skill.dirPath, dstDir);
      this.ctx.log.info(`Skill synced: "${skill.name}" v${skill.version} → workspace`);
    }
  }

  private cleanSync(srcDir: string, dstDir: string): void {
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true });
    }
    fs.mkdirSync(dstDir, { recursive: true });
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}
