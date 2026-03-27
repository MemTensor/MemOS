import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "../storage/sqlite";
import type { RecallEngine } from "../recall/engine";
import type { Embedder } from "../embedding";
import type { Chunk, Task, Skill, PluginContext, SkillGenerateOutput } from "../types";
import { DEFAULTS } from "../types";
import type { CreateEvalResult } from "./evaluator";
import { SkillValidator } from "./validator";
import { buildSkillConfigChain, callLLMWithFallback } from "../shared/llm-call";

// ─── Step 1: Generate SKILL.md ───
// Based on Anthropic skill-creator principles:
//   - Progressive disclosure (metadata ~100 words → body <500 lines → resources on demand)
//   - Description as primary trigger mechanism — write it "pushy"
//   - Explain WHY, not pile up MUST/NEVER
//   - Imperative form, keep it concise
//   - Generalize from the specific task, don't over-fit

const STEP1_SKILL_MD_PROMPT = `You are a Skill creation expert. Your job is to distill a completed task's execution record into a reusable SKILL.md file.

This Skill is special: it comes from real execution experience — every step was actually run, every pitfall was actually encountered and resolved.

## Core principles (follow strictly but do NOT include these in output)

### Progressive disclosure
- The frontmatter description (~100 words) is ALWAYS in the agent's context — it must be self-sufficient for deciding whether to use this skill.
- The SKILL.md body loads when triggered — keep it under 400 lines, focused, no fluff.
- If the task involved large configs/scripts, mention them but DON'T inline everything — just reference that scripts/ or references/ may contain them.

### Description as trigger mechanism
The description field decides whether the agent activates this skill. Write it "proactively":
- Don't just say what it does — list the situations, keywords, and phrasings that should trigger it.
- Claude/agents tend to under-trigger skills. Counter this by being explicit about when to use it.
- Bad: "How to deploy Node.js to Docker"
- Good: "How to containerize and deploy a Node.js application using Docker. Use when the user mentions Docker deployment, Dockerfile writing, container builds, multi-stage builds, port mapping, .dockerignore, image optimization, CI/CD container pipelines, or any task involving packaging a Node/JS backend into a container — even if they don't say 'Docker' explicitly but describe wanting to 'package the app for production' or 'run it anywhere'."

### Writing style
- Use imperative form
- Explain WHY for each step, not just HOW — today's LLMs respond better to reasoning than rigid rules
- Seeing yourself write ALWAYS or NEVER in caps is a yellow flag — rephrase with reasoning instead
- Generalize from the specific task so the skill works for similar future scenarios, don't over-fit to this exact project
- Keep real commands/code/config from the task record — these are verified to work

### Language matching (CRITICAL)
You MUST write the ENTIRE skill in the SAME language as the user's messages in the task record.
- If the user wrote in Chinese → the skill title, description, all prose sections MUST be in Chinese
- If the user wrote in English → write in English
- If mixed → use the language that appears most in the user's messages
- The "name" field in frontmatter should still use English kebab-case (it's a machine identifier)
- But "description", section headings, step explanations, pitfall descriptions — ALL must match the user's language
- Code/commands stay in their original language (they are language-agnostic)
DO NOT default to English. Look at the task record below and match its language.

## Output format

Output ONLY the complete SKILL.md content. No extra text before or after.

---
name: "{NAME}"
description: "{A natural, proactive description. 60-120 words. Cover what it does + multiple phrasings/scenarios that should trigger it. Be pushy about triggering — list keywords, alternative descriptions, edge-case phrasings.}"
metadata: {{ "openclaw": {{ "emoji": "{emoji}" }} }}
---

# {Title — clear, action-oriented}

{One sentence: what this skill helps you do and why it's valuable}

## When to use this skill
{2-4 bullet points describing the scenarios. Focus on the user's INTENT, not just keywords. Example: "When you need to get a Node app running reliably in a container and want to avoid common pitfalls like bloated images or missing health checks."}

## Steps
{Numbered or sectioned steps extracted from the task. EVERY step actually performed must be included — do NOT skip or generalize away concrete steps like "configure security groups", "set environment variables", etc. For each step:
1. What to do (keep inline code short — if a step involves a long script or config, write a brief summary here and say "see scripts/<filename> for the complete script")
2. Why this matters (one sentence explaining the reasoning)
Keep the actual commands/code from the task — they're verified. But avoid duplicating large code blocks that will also appear in scripts/ — reference them instead.}

## Pitfalls and solutions
{What went wrong during the task and how it was fixed. Format:
❌ Wrong approach → Why it fails → ✅ Correct approach
These are the most valuable parts — real debugging experience.}

## Key code and configuration
{Complete, verified code blocks and config files. Don't summarize code — keep it complete and runnable.}

## Environment and prerequisites
{Versions, dependencies, permissions, OS requirements — anything needed to reproduce.}

## Companion files
{If the skill comes with automation scripts or reference docs, list them here so the reader knows they exist:
- \`scripts/<filename>\` — brief description of what this script does
- \`references/<filename>\` — brief description of what this reference covers
If no companion files exist, omit this section entirely.}

## Task record

Task title: {TITLE}
Task summary:
{SUMMARY}

Conversation highlights:
{CONVERSATION}`;

// ─── Step 2: Extract scripts ───

const STEP2_SCRIPTS_PROMPT = `Based on the following SKILL.md and task record, extract reusable automation scripts.

Rules:
- Only extract if the task record contains concrete shell commands, Python scripts, or TypeScript code that form a complete, reusable automation.
- Each script must be self-contained and runnable.
- If there are no automatable scripts (e.g., the task was mostly manual steps or config editing), return an empty array.
- Don't fabricate scripts — only extract what was actually used in the task.
- The script should COMPLEMENT the SKILL.md, not duplicate it. If SKILL.md already has the steps in detail, the script should be the automation version. If SKILL.md references the script, the script should contain the full implementation.
- The script filename should be descriptive (e.g., "deploy.sh", "configure_openclaw.sh", "setup_security_group.sh").

SKILL.md:
{SKILL_CONTENT}

Task conversation highlights:
{CONVERSATION}

Reply with a JSON array only. No extra text:
[
  {{ "filename": "deploy.sh", "content": "#!/bin/bash\\n..." }},
  {{ "filename": "setup.py", "content": "..." }}
]

If no scripts should be extracted, reply with: []`;

// ─── Step 3: Generate evals ───

const STEP3_EVALS_PROMPT = `Based on the following skill, generate realistic test prompts that should trigger this skill.

Requirements:
- Write 3-4 test prompts that a real user would type
- Mix of direct and indirect phrasings (some obviously match the skill, some are edge cases)
- Include realistic details: file paths, project names, specific error messages
- Mix formal and casual tones, include some with typos or shorthand
- Each prompt should be complex enough that the agent would need the skill (not simple Q&A)
- Write expectations that are specific and verifiable
- LANGUAGE RULE: Write prompts and expectations in the SAME language as the skill content. If the skill is in Chinese, write Chinese test prompts. If English, write English.

Skill:
{SKILL_CONTENT}

Reply with a JSON array only:
[
  {{
    "id": 1,
    "prompt": "A realistic user message that should trigger this skill",
    "expectations": ["Specific expected behavior 1", "Specific expected behavior 2"],
    "trigger_confidence": "high|medium"
  }}
]`;

// ─── Step 2b: Extract references ───

const STEP2B_REFS_PROMPT = `Based on the following SKILL.md and task record, extract reference documentation worth preserving.

Rules:
- Only extract if the task involved important API docs, configuration references, or technical notes that would be useful for future similar tasks.
- Each reference should be a standalone markdown document.
- Don't duplicate what's already in SKILL.md — references are for deeper detail.
- If there's nothing worth extracting, return an empty array.
- LANGUAGE RULE: Write reference content in the SAME language as the SKILL.md and task record. Chinese input → Chinese output.

SKILL.md:
{SKILL_CONTENT}

Task conversation highlights:
{CONVERSATION}

Reply with a JSON array only:
[
  {{ "filename": "api-notes.md", "content": "# API Reference\\n..." }}
]

If no references should be extracted, reply with: []`;

export class SkillGenerator {
  private validator: SkillValidator;
  private embedder: Embedder | null = null;

  constructor(
    private store: SqliteStore,
    private engine: RecallEngine,
    private ctx: PluginContext,
    embedder?: Embedder,
  ) {
    this.validator = new SkillValidator(ctx);
    this.embedder = embedder ?? null;
  }

  async generate(task: Task, chunks: Chunk[], evalResult: CreateEvalResult): Promise<Skill> {
    const conversationText = this.buildConversationText(chunks);

    // ── Step 1: Generate SKILL.md (primary, largest output) ──
    this.ctx.log.info(`SkillGenerator: Step 1/4 — generating SKILL.md for "${evalResult.suggestedName}"`);
    let skillMdContent = await this.step1GenerateSkillMd(task, conversationText, evalResult);

    const skillsStoreDir = path.join(this.ctx.stateDir, "skills-store");
    const dirPath = path.join(skillsStoreDir, evalResult.suggestedName);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, "SKILL.md"), skillMdContent, "utf-8");

    // ── Step 2: Extract scripts (parallel with refs) ──
    this.ctx.log.info(`SkillGenerator: Step 2/4 — extracting scripts and references`);
    const [scripts, references] = await Promise.all([
      this.step2ExtractScripts(skillMdContent, conversationText),
      this.step2bExtractReferences(skillMdContent, conversationText),
    ]);

    if (scripts.length > 0) {
      const scriptsDir = path.join(dirPath, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const s of scripts) {
        fs.writeFileSync(path.join(scriptsDir, s.filename), s.content, "utf-8");
      }
    }

    if (references.length > 0) {
      const refsDir = path.join(dirPath, "references");
      fs.mkdirSync(refsDir, { recursive: true });
      for (const r of references) {
        fs.writeFileSync(path.join(refsDir, r.filename), r.content, "utf-8");
      }
    }

    // Ensure SKILL.md has companion files section
    if (scripts.length > 0 || references.length > 0) {
      const hasCompanionSection = /## Companion files|## 附属文件|## 辅助文件/.test(skillMdContent);
      if (!hasCompanionSection) {
        const companionLines: string[] = ["\n\n## Companion files\n"];
        for (const s of scripts) {
          companionLines.push(`- \`scripts/${s.filename}\` — automation script`);
        }
        for (const r of references) {
          companionLines.push(`- \`references/${r.filename}\` — reference documentation`);
        }
        skillMdContent += companionLines.join("\n");
        fs.writeFileSync(path.join(dirPath, "SKILL.md"), skillMdContent, "utf-8");
      }
    }

    // ── Step 3: Generate evals ──
    this.ctx.log.info(`SkillGenerator: Step 3/4 — generating eval test cases`);
    const evals = await this.step3GenerateEvals(skillMdContent);

    if (evals.length > 0) {
      const evalsDir = path.join(dirPath, "evals");
      fs.mkdirSync(evalsDir, { recursive: true });
      fs.writeFileSync(
        path.join(evalsDir, "evals.json"),
        JSON.stringify({ skill_name: evalResult.suggestedName, evals }, null, 2),
        "utf-8",
      );
    }

    // ── Step 4: Validate + verify evals ──
    this.ctx.log.info(`SkillGenerator: Step 4/4 — validating and verifying`);
    const validation = await this.validator.validate(dirPath);
    const evalVerification = await this.verifyEvals(evals);

    const description = this.parseDescription(skillMdContent);
    const status = validation.qualityScore !== null && validation.qualityScore < 6 ? "draft" as const : "active" as const;

    const skillId = uuid();
    const now = Date.now();
    const skill: Skill = {
      id: skillId,
      name: evalResult.suggestedName,
      description,
      version: 1,
      status,
      tags: JSON.stringify(evalResult.suggestedTags),
      sourceType: "task",
      dirPath,
      installed: 0,
      owner: "agent:main",
      visibility: "private",
      qualityScore: validation.qualityScore,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSkill(skill);

    if (description && this.embedder) {
      try {
        const [descEmb] = await this.embedder.embed([description]);
        if (descEmb) this.store.upsertSkillEmbedding(skillId, descEmb);
      } catch (err) {
        this.ctx.log.warn(`SkillGenerator: embedding for description failed: ${err}`);
      }
    }

    this.store.insertSkillVersion({
      id: uuid(),
      skillId,
      version: 1,
      content: skillMdContent,
      changelog: `Initial generation from task "${task.title}"`,
      changeSummary: `首次从任务"${task.title}"的实际执行记录中提炼生成。${description ? `该技能涵盖：${description.slice(0, 200)}` : ""}${scripts.length > 0 ? ` 包含 ${scripts.length} 个辅助脚本。` : ""}${evals.length > 0 ? ` 附带 ${evals.length} 个测试用例（${evalVerification.hitCount}/${evals.length} 通过命中验证）。` : ""}`,
      upgradeType: "create",
      sourceTaskId: task.id,
      metrics: JSON.stringify({
        dimensions: [],
        confidence: evalResult.confidence,
        scripts: scripts.map(s => s.filename),
        references: references.map(r => r.filename),
        evalCount: evals.length,
        evalVerification,
        validation: {
          errors: validation.errors,
          warnings: validation.warnings,
          suggestions: validation.suggestions,
        },
      }),
      qualityScore: validation.qualityScore,
      createdAt: now,
    });

    if (validation.warnings.length > 0) {
      this.ctx.log.info(`Skill "${skill.name}" validation warnings: ${validation.warnings.join("; ")}`);
    }

    this.ctx.log.info(
      `Skill generated: "${skill.name}" v1 [${status}] score=${validation.qualityScore ?? "N/A"} `
      + `scripts=${scripts.length} refs=${references.length} evals=${evals.length} `
      + `evalHits=${evalVerification.hitCount}/${evals.length} `
      + `from task "${task.title}"`,
    );
    return skill;
  }

  // ─── Step 1: SKILL.md generation ───

  private detectLanguage(text: string): string {
    const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0;
    const total = text.replace(/\s+/g, "").length || 1;
    if (cjk / total > 0.15) return "Chinese (中文)";
    return "English";
  }

  private async step1GenerateSkillMd(task: Task, conversationText: string, evalResult: CreateEvalResult): Promise<string> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) throw new Error("No LLM configured for skill generation");

    const lang = this.detectLanguage(conversationText);
    const langInstruction = `\n\n⚠️ LANGUAGE REQUIREMENT: The task record is in ${lang}. You MUST write ALL prose content (description, headings, explanations, pitfalls) in ${lang}. Only the "name" field stays in English kebab-case.\n`;

    const prompt = STEP1_SKILL_MD_PROMPT
      .replace("{NAME}", evalResult.suggestedName)
      .replace("{TITLE}", task.title)
      .replace("{SUMMARY}", task.summary.slice(0, 5000))
      .replace("{CONVERSATION}", conversationText.slice(0, 12000))
      + langInstruction;

    const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillGenerator.step1", { maxTokens: 6000, temperature: 0.2, timeoutMs: 120_000, openclawAPI: this.ctx.openclawAPI });

    const trimmed = raw.trim();
    if (trimmed.startsWith("---")) return trimmed;
    const fmStart = trimmed.indexOf("---");
    if (fmStart !== -1) return trimmed.slice(fmStart);
    return trimmed;
  }

  // ─── Step 2: Extract scripts ───

  private async step2ExtractScripts(
    skillContent: string,
    conversationText: string,
  ): Promise<Array<{ filename: string; content: string }>> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) return [];

    const prompt = STEP2_SCRIPTS_PROMPT
      .replace("{SKILL_CONTENT}", skillContent.slice(0, 4000))
      .replace("{CONVERSATION}", conversationText.slice(0, 6000));

    try {
      const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillGenerator.scripts", { maxTokens: 3000, temperature: 0.1, timeoutMs: 120_000, openclawAPI: this.ctx.openclawAPI });
      return this.parseJSONArray<{ filename: string; content: string }>(raw);
    } catch (err) {
      this.ctx.log.warn(`SkillGenerator: script extraction failed: ${err}`);
      return [];
    }
  }

  // ─── Step 2b: Extract references ───

  private async step2bExtractReferences(
    skillContent: string,
    conversationText: string,
  ): Promise<Array<{ filename: string; content: string }>> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) return [];

    const prompt = STEP2B_REFS_PROMPT
      .replace("{SKILL_CONTENT}", skillContent.slice(0, 4000))
      .replace("{CONVERSATION}", conversationText.slice(0, 6000));

    try {
      const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillGenerator.refs", { maxTokens: 3000, temperature: 0.1, timeoutMs: 120_000, openclawAPI: this.ctx.openclawAPI });
      return this.parseJSONArray<{ filename: string; content: string }>(raw);
    } catch (err) {
      this.ctx.log.warn(`SkillGenerator: reference extraction failed: ${err}`);
      return [];
    }
  }

  // ─── Step 3: Generate evals ───

  private async step3GenerateEvals(
    skillContent: string,
  ): Promise<Array<{ id: number; prompt: string; expectations: string[]; trigger_confidence?: string }>> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) return [];

    const lang = this.detectLanguage(skillContent);
    const prompt = STEP3_EVALS_PROMPT
      .replace("{SKILL_CONTENT}", skillContent.slice(0, 4000))
      + `\n\n⚠️ LANGUAGE: Write test prompts and expectations in ${lang}, matching the skill's language.\n`;

    try {
      const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillGenerator.evals", { maxTokens: 2000, temperature: 0.3, timeoutMs: 120_000, openclawAPI: this.ctx.openclawAPI });
      return this.parseJSONArray(raw);
    } catch (err) {
      this.ctx.log.warn(`SkillGenerator: eval generation failed: ${err}`);
      return [];
    }
  }

  // ─── Step 4: Verify evals via memory search ───

  private async verifyEvals(
    evals: Array<{ id: number; prompt: string; expectations: string[] }>,
  ): Promise<{ hitCount: number; results: Array<{ evalId: number; hit: boolean; topScore: number }> }> {
    const results: Array<{ evalId: number; hit: boolean; topScore: number }> = [];
    let hitCount = 0;

    for (const ev of evals.slice(0, 4)) {
      try {
        const searchResult = await this.engine.search({
          query: ev.prompt,
          maxResults: 5,
          minScore: 0.3,
        });

        const topScore = searchResult.hits.length > 0 ? searchResult.hits[0].score : 0;
        const hasSkillHit = searchResult.hits.some(h => h.skillId != null);
        const hit = searchResult.hits.length > 0 && topScore >= 0.4;

        if (hit) hitCount++;
        results.push({ evalId: ev.id, hit, topScore });

        this.ctx.log.debug(
          `SkillGenerator eval verify: "${ev.prompt.slice(0, 50)}..." → `
          + `hits=${searchResult.hits.length} topScore=${topScore.toFixed(3)} skillHit=${hasSkillHit}`,
        );
      } catch (err) {
        this.ctx.log.warn(`SkillGenerator: eval verification failed for eval ${ev.id}: ${err}`);
        results.push({ evalId: ev.id, hit: false, topScore: 0 });
      }
    }

    return { hitCount, results };
  }


  // ─── Helpers ───

  private parseJSONArray<T>(raw: string): T[] {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const arr = JSON.parse(match[0]);
      return Array.isArray(arr) ? arr : [];
    } catch {
      this.ctx.log.warn("SkillGenerator: JSON array parse failed");
      return [];
    }
  }

  private buildConversationText(chunks: Chunk[]): string {
    const lines: string[] = [];
    const redact = this.ctx.config.skillEvolution?.redactSensitiveInSkill ?? true;

    for (const c of chunks) {
      let roleLabel: string;
      switch (c.role) {
        case "user": roleLabel = "User"; break;
        case "assistant": roleLabel = "Assistant"; break;
        case "tool": roleLabel = "Tool"; break;
        case "system": roleLabel = "System"; break;
        default: continue;
      }

      let content = c.content;
      if (c.role === "system") continue;

      if (c.role === "tool") {
        content = this.truncateToolOutput(content);
      }

      if (redact) {
        content = SkillGenerator.redactSensitive(content);
      }

      lines.push(`[${roleLabel}]: ${content}`);
    }
    return lines.join("\n\n");
  }

  private truncateToolOutput(content: string): string {
    const MAX_TOOL_OUTPUT = 1500;
    if (content.length <= MAX_TOOL_OUTPUT) return content;
    const head = content.slice(0, MAX_TOOL_OUTPUT * 0.6);
    const tail = content.slice(-MAX_TOOL_OUTPUT * 0.3);
    return `${head}\n... (truncated ${content.length - MAX_TOOL_OUTPUT} chars) ...\n${tail}`;
  }

  static redactSensitive(text: string): string {
    let result = text;
    result = result.replace(/\bsk-[a-zA-Z0-9]{20,}\b/g, "sk-***REDACTED***");
    result = result.replace(/\bBearer\s+[a-zA-Z0-9_\-.]{20,}\b/g, "Bearer ***REDACTED***");
    result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***REDACTED***");
    result = result.replace(/(api[_-]?key|secret|token|password|credential)\s*[:=]\s*["']([^"']{8,})["']/gi,
      (match, key) => `${key}="***REDACTED***"`);
    result = result.replace(/\/Users\/[a-zA-Z0-9._-]+\//g, "/Users/****/");
    result = result.replace(/\/home\/[a-zA-Z0-9._-]+\//g, "/home/****/");
    result = result.replace(/C:\\Users\\[a-zA-Z0-9._-]+\\/g, "C:\\Users\\****\\");
    return result;
  }

  private parseDescription(content: string): string {
    const match = content.match(/description:\s*"([^"]+)"/);
    if (match) return match[1];
    const match2 = content.match(/description:\s*'([^']+)'/);
    if (match2) return match2[1];
    return "";
  }
}
