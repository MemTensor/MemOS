import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "../storage/sqlite";
import type { PluginContext } from "../types";

export class SkillInstaller {
  private workspaceSkillsDir: string;

  constructor(
    private store: SqliteStore,
    private ctx: PluginContext,
  ) {
    this.workspaceSkillsDir = path.join(ctx.workspaceDir, "skills");
  }

  install(skillId: string): { installed: boolean; path: string; message: string } {
    const skill = this.store.getSkill(skillId);
    if (!skill) return { installed: false, path: "", message: "Skill not found" };

    if (!fs.existsSync(skill.dirPath)) {
      return { installed: false, path: "", message: `Skill directory not found: ${skill.dirPath}` };
    }

    const dstDir = path.join(this.workspaceSkillsDir, skill.name);
    fs.mkdirSync(dstDir, { recursive: true });
    fs.cpSync(skill.dirPath, dstDir, { recursive: true });
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
    if (fs.existsSync(dstDir) && fs.existsSync(skill.dirPath)) {
      fs.cpSync(skill.dirPath, dstDir, { recursive: true });
      this.ctx.log.info(`Skill synced: "${skill.name}" v${skill.version} → workspace`);
    }
  }
}
