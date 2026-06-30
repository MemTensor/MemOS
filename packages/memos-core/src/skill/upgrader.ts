import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "../storage/sqlite";
import type { Task, Skill, PluginContext } from "../types";
import type { UpgradeEvalResult } from "./evaluator";
import { SkillValidator } from "./validator";
import { buildSkillConfigChain, callLLMWithFallback } from "../shared/llm-call";

const UPGRADE_PROMPT = `You are a Skill upgrade expert. You're merging new real-world execution experience into an existing Skill to make it better.

Remember: this is based on ACTUAL execution — the new task was really run, errors were really encountered and fixed. This makes the upgrade valuable.

## Core principles (follow strictly but do NOT include in output)

### Progressive disclosure
- Keep the frontmatter description as the primary trigger mechanism (~60-120 words, proactive — see below)
- SKILL.md body should stay under 400 lines total
- If content grows too large, consider moving deep details to references/ and just pointing to them

### Description as trigger
The description decides whether the agent activates this skill. Write it "proactively":
- Cover what it does + situations/keywords/phrasings that should trigger it
- Be explicit about edge cases — "even if the user doesn't say X explicitly but describes Y"
- If the new task reveals new trigger scenarios, ADD them to the description

### Writing style
- Imperative form
- Explain WHY for each step — reasoning beats rigid rules
- Avoid ALWAYS/NEVER in caps — rephrase with reasoning instead
- Generalize from specific tasks
- Keep verified commands/code/config from both old and new tasks
- CRITICAL: Match the language of the skill and task record. If the existing skill or the new task record is in Chinese, write ALL upgraded content in Chinese. If English, write in English. Only the "name" field stays in English kebab-case. DO NOT default to English.

## Existing skill (v{VERSION}):
{SKILL_CONTENT}

## Upgrade context
- Type: {UPGRADE_TYPE}
- Dimensions improved: {DIMENSIONS}
- Reason: {REASON}
- Merge strategy: {MERGE_STRATEGY}

## New task record
Title: {TITLE}
Summary:
{SUMMARY}

## Merge rules
1. Preserve all valid core content from the existing skill — upgrades should ADD value, not lose it
2. Merge new experience strategically:
   - Better approach found → replace old, keep old as "Alternative approach" if it's still valid
   - New scenario discovered → add a new section (don't replace unrelated content)
   - Bug/error corrected → replace directly, add to "Pitfalls and solutions" section
   - Performance improvement → update steps, note the improvement in why-reasoning
3. Update description if new scenarios/keywords/triggers need coverage
4. Update "When to use this skill" section if the new task reveals new use cases
5. If a "Pitfalls and solutions" section exists, append new pitfalls; if it doesn't exist, create it
6. Total length ≤ 400 lines — if approaching limit, move detailed configs/references to references/
7. Add version comment at end:
   <!-- v{NEW_VERSION}: {one-line change note} (from task: {TASK_ID}) -->

## Output format

Output the complete upgraded SKILL.md (with full frontmatter), then on a new line write:
---CHANGELOG---
{one-line changelog title}
---CHANGE_SUMMARY---
{A 3-5 sentence summary in the same language as the skill. Cover: (1) What specifically was changed and what triggered the change, (2) What concrete new capability or improvement this version brings, (3) What real problem from the new task this solves. Write for a human reader who wants to quickly understand the value of this upgrade.}`;

export class SkillUpgrader {
  private validator: SkillValidator;

  constructor(
    private store: SqliteStore,
    private ctx: PluginContext,
  ) {
    this.validator = new SkillValidator(ctx);
  }

  async upgrade(task: Task, skill: Skill, evalResult: UpgradeEvalResult): Promise<{ upgraded: boolean; qualityScore: number | null }> {
    const currentContent = this.readCurrentContent(skill);
    if (!currentContent) {
      this.ctx.log.warn(`SkillUpgrader: could not read content for "${skill.name}"`);
      return { upgraded: false, qualityScore: null };
    }

    const { newContent, changelog, changeSummary } = await this.callUpgradeLLM(task, skill, currentContent, evalResult);
    if (!newContent || newContent.length < 100) {
      this.ctx.log.warn(`SkillUpgrader: generated content too short for "${skill.name}", skipping`);
      return { upgraded: false, qualityScore: null };
    }

    const backupDir = skill.dirPath + ".backup-" + Date.now();
    try { fs.cpSync(skill.dirPath, backupDir, { recursive: true }); } catch { /* best-effort */ }

    fs.writeFileSync(path.join(skill.dirPath, "SKILL.md"), newContent, "utf-8");

    await this.rebuildCompanionFiles(skill, newContent, task);

    const validation = await this.validator.validate(skill.dirPath, {
      previousContent: currentContent,
    });

    if (!validation.valid) {
      this.ctx.log.warn(`SkillUpgrader: validation failed for "${skill.name}", reverting: ${validation.errors.join("; ")}`);
      if (fs.existsSync(backupDir)) {
        fs.rmSync(skill.dirPath, { recursive: true });
        fs.renameSync(backupDir, skill.dirPath);
      } else {
        fs.writeFileSync(path.join(skill.dirPath, "SKILL.md"), currentContent, "utf-8");
      }
      return { upgraded: false, qualityScore: null };
    }

    try { if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true }); } catch { /* cleanup */ }

    const newVersion = skill.version + 1;
    const newDescription = this.parseDescription(newContent) || skill.description;

    const newStatus = validation.qualityScore !== null && validation.qualityScore < 6 ? "draft" as const : skill.status;

    this.store.updateSkill(skill.id, {
      description: newDescription,
      version: newVersion,
      status: newStatus,
      qualityScore: validation.qualityScore,
      updatedAt: Date.now(),
    });

    this.store.insertSkillVersion({
      id: uuid(),
      skillId: skill.id,
      version: newVersion,
      content: newContent,
      changelog: changelog || `Upgraded from task "${task.title}"`,
      changeSummary: changeSummary || `基于任务"${task.title}"的执行记录进行了版本升级。`,
      upgradeType: evalResult.upgradeType,
      sourceTaskId: task.id,
      metrics: JSON.stringify({
        dimensions: evalResult.dimensions,
        confidence: evalResult.confidence,
        validation: {
          errors: validation.errors,
          warnings: validation.warnings,
          suggestions: validation.suggestions,
        },
      }),
      qualityScore: validation.qualityScore,
      createdAt: Date.now(),
    });

    if (validation.warnings.length > 0) {
      this.ctx.log.info(`Skill "${skill.name}" upgrade warnings: ${validation.warnings.join("; ")}`);
    }

    this.ctx.log.info(
      `Skill upgraded: "${skill.name}" v${skill.version} → v${newVersion} [${newStatus}] score=${validation.qualityScore ?? "N/A"}`,
    );
    return { upgraded: true, qualityScore: validation.qualityScore };
  }

  private readCurrentContent(skill: Skill): string | null {
    const filePath = path.join(skill.dirPath, "SKILL.md");
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      const sv = this.store.getLatestSkillVersion(skill.id);
      return sv?.content ?? null;
    }
  }

  private async callUpgradeLLM(
    task: Task,
    skill: Skill,
    currentContent: string,
    evalResult: UpgradeEvalResult,
  ): Promise<{ newContent: string; changelog: string; changeSummary: string }> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) throw new Error("No LLM configured for skill upgrade");

    const newVersion = skill.version + 1;

    const detectLang = (text: string): string => {
      const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0;
      const total = text.replace(/\s+/g, "").length || 1;
      return (cjk / total > 0.15) ? "Chinese (中文)" : "English";
    };
    const lang = detectLang(task.summary + currentContent);
    const langInstruction = `\n\n⚠️ LANGUAGE REQUIREMENT: The content is in ${lang}. You MUST write ALL prose (description, headings, explanations, pitfalls, changelog, change summary) in ${lang}. Only the "name" field stays in English kebab-case.\n`;

    const prompt = UPGRADE_PROMPT
      .replace("{VERSION}", String(skill.version))
      .replace("{SKILL_CONTENT}", currentContent.slice(0, 6000))
      .replace("{UPGRADE_TYPE}", evalResult.upgradeType)
      .replace("{DIMENSIONS}", evalResult.dimensions.join(", "))
      .replace("{REASON}", evalResult.reason)
      .replace("{MERGE_STRATEGY}", evalResult.mergeStrategy)
      .replace("{TITLE}", task.title)
      .replace("{SUMMARY}", task.summary.slice(0, 4000))
      .replace("{NEW_VERSION}", String(newVersion))
      .replace("{TASK_ID}", task.id)
      + langInstruction;

    const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillUpgrader.upgrade", { maxTokens: 6000, temperature: 0.2, timeoutMs: 90_000, openclawAPI: this.ctx.openclawAPI });

    const changelogSep = raw.indexOf("---CHANGELOG---");
    if (changelogSep !== -1) {
      const newContent = raw.slice(0, changelogSep).trim();
      const afterChangelog = raw.slice(changelogSep + "---CHANGELOG---".length).trim();

      const summarySep = afterChangelog.indexOf("---CHANGE_SUMMARY---");
      if (summarySep !== -1) {
        const changelog = afterChangelog.slice(0, summarySep).trim();
        const changeSummary = afterChangelog.slice(summarySep + "---CHANGE_SUMMARY---".length).trim();
        return { newContent, changelog, changeSummary };
      }
      return { newContent, changelog: afterChangelog, changeSummary: "" };
    }

    return { newContent: raw, changelog: "", changeSummary: "" };
  }

  private parseDescription(content: string): string {
    const match = content.match(/description:\s*"([^"]+)"/);
    if (match) return match[1];
    const match2 = content.match(/description:\s*'([^']+)'/);
    if (match2) return match2[1];
    return "";
  }

  private async rebuildCompanionFiles(skill: Skill, newContent: string, task: Task): Promise<void> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) return;

    const chunks = this.store.getChunksByTask(task.id);
    const conversationText = chunks
      .filter(c => c.role === "user" || c.role === "assistant" || c.role === "tool")
      .map(c => `[${c.role === "user" ? "User" : c.role === "assistant" ? "Assistant" : "Tool"}]: ${c.content.slice(0, 500)}`)
      .join("\n\n")
      .slice(0, 6000);

    const scriptsPrompt = `Based on the following upgraded SKILL.md and task record, extract reusable automation scripts.
Rules:
- Only extract if the task record contains concrete shell commands, Python scripts, or TypeScript code that form a complete, reusable automation.
- Each script must be self-contained and runnable.
- If there are no automatable scripts, return an empty array.
- Don't fabricate scripts — only extract what was actually used.

SKILL.md:
${newContent.slice(0, 4000)}

Task conversation highlights:
${conversationText}

Reply with a JSON array only:
[{"filename": "deploy.sh", "content": "#!/bin/bash\\n..."}]
If no scripts, reply with: []`;

    try {
      const raw = await callLLMWithFallback(chain, scriptsPrompt, this.ctx.log, "SkillUpgrader.scripts", {
        maxTokens: 3000, temperature: 0.1, timeoutMs: 60_000, openclawAPI: this.ctx.openclawAPI,
      });
      const scripts = this.parseJSONArray<{ filename: string; content: string }>(raw);

      const scriptsDir = path.join(skill.dirPath, "scripts");
      if (fs.existsSync(scriptsDir)) fs.rmSync(scriptsDir, { recursive: true });
      if (scripts.length > 0) {
        fs.mkdirSync(scriptsDir, { recursive: true });
        for (const s of scripts) {
          fs.writeFileSync(path.join(scriptsDir, s.filename), s.content, "utf-8");
        }
        this.ctx.log.info(`SkillUpgrader: rebuilt ${scripts.length} scripts for "${skill.name}"`);
      }
    } catch (err) {
      this.ctx.log.warn(`SkillUpgrader: companion scripts rebuild failed: ${err}`);
    }

    try {
      const evalsPrompt = `Based on the following skill, generate 3-4 realistic test prompts that should trigger this skill.
Requirements:
- Write test prompts that a real user would type, mix direct and indirect phrasings
- LANGUAGE RULE: Write in the SAME language as the skill content.

Skill:
${newContent.slice(0, 4000)}

Reply with a JSON array only:
[{"id": 1, "prompt": "A realistic user message", "expectations": ["Expected behavior 1"], "trigger_confidence": "high"}]`;

      const raw = await callLLMWithFallback(chain, evalsPrompt, this.ctx.log, "SkillUpgrader.evals", {
        maxTokens: 2000, temperature: 0.3, timeoutMs: 60_000, openclawAPI: this.ctx.openclawAPI,
      });
      const evals = this.parseJSONArray<{ id: number; prompt: string; expectations: string[] }>(raw);

      const evalsDir = path.join(skill.dirPath, "evals");
      if (fs.existsSync(evalsDir)) fs.rmSync(evalsDir, { recursive: true });
      if (evals.length > 0) {
        fs.mkdirSync(evalsDir, { recursive: true });
        fs.writeFileSync(
          path.join(evalsDir, "evals.json"),
          JSON.stringify({ skill_name: skill.name, evals }, null, 2),
          "utf-8",
        );
        this.ctx.log.info(`SkillUpgrader: rebuilt ${evals.length} evals for "${skill.name}"`);
      }
    } catch (err) {
      this.ctx.log.warn(`SkillUpgrader: companion evals rebuild failed: ${err}`);
    }

    try {
      const refsPrompt = `Based on the following upgraded SKILL.md and task record, extract reference documentation worth preserving.
Rules:
- Only extract real reference content that appeared in the task (API docs, config examples, architecture notes).
- Each reference should be a standalone document useful for understanding the skill's domain.
- If there are no meaningful references, return an empty array.
- Don't fabricate content — only extract what was actually discussed or used.
- LANGUAGE RULE: Write in the SAME language as the skill content.

SKILL.md:
${newContent.slice(0, 4000)}

Task conversation highlights:
${conversationText}

Reply with a JSON array only:
[{"filename": "api-notes.md", "content": "# API Reference\\n..."}]
If no references, reply with: []`;

      const raw = await callLLMWithFallback(chain, refsPrompt, this.ctx.log, "SkillUpgrader.references", {
        maxTokens: 3000, temperature: 0.1, timeoutMs: 60_000, openclawAPI: this.ctx.openclawAPI,
      });
      const refs = this.parseJSONArray<{ filename: string; content: string }>(raw);

      const refsDir = path.join(skill.dirPath, "references");
      if (fs.existsSync(refsDir)) fs.rmSync(refsDir, { recursive: true });
      if (refs.length > 0) {
        fs.mkdirSync(refsDir, { recursive: true });
        for (const r of refs) {
          fs.writeFileSync(path.join(refsDir, r.filename), r.content, "utf-8");
        }
        this.ctx.log.info(`SkillUpgrader: rebuilt ${refs.length} references for "${skill.name}"`);
      }
    } catch (err) {
      this.ctx.log.warn(`SkillUpgrader: companion references rebuild failed: ${err}`);
    }
  }

  private parseJSONArray<T>(raw: string): T[] {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const arr = JSON.parse(match[0]);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
}
