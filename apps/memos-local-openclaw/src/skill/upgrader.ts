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

    fs.writeFileSync(path.join(skill.dirPath, "SKILL.md"), newContent, "utf-8");

    const validation = await this.validator.validate(skill.dirPath, {
      previousContent: currentContent,
    });

    if (!validation.valid) {
      this.ctx.log.warn(`SkillUpgrader: validation failed for "${skill.name}", reverting: ${validation.errors.join("; ")}`);
      fs.writeFileSync(path.join(skill.dirPath, "SKILL.md"), currentContent, "utf-8");
      return { upgraded: false, qualityScore: null };
    }

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

    const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillUpgrader.upgrade", { maxTokens: 6000, temperature: 0.2, timeoutMs: 90_000 });

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
}
