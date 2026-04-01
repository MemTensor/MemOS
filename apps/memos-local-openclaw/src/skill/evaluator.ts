import type { Chunk, Task, Skill, PluginContext } from "../types";
import { DEFAULTS } from "../types";
import { buildSkillConfigChain, callLLMWithFallback } from "../shared/llm-call";

export interface CreateEvalResult {
  shouldGenerate: boolean;
  reason: string;
  suggestedName: string;
  suggestedTags: string[];
  confidence: number;
}

export interface UpgradeEvalResult {
  shouldUpgrade: boolean;
  upgradeType: "refine" | "extend" | "fix";
  dimensions: string[];
  reason: string;
  mergeStrategy: string;
  confidence: number;
}

const CREATE_EVAL_PROMPT = `You are a strict experience evaluation expert. Based on the completed task record below, decide whether this task contains **reusable, transferable** experience worth distilling into a "skill".

A skill is a reusable guide that helps an AI agent handle **the same type of task** better in the future. The key question is: "Will someone likely need to do this exact type of thing again?"

STRICT criteria — must meet ALL of:
1. **Repeatable**: The task type is likely to recur (not a one-off personal conversation)
2. **Transferable**: The approach/solution would help others facing the same problem
3. **Technical depth**: Contains non-trivial steps, commands, code, configs, or diagnostic reasoning

Worth distilling (must meet criteria above AND at least ONE below):
- Solves a recurring technical problem with a specific approach/workflow
- Went through trial-and-error (wrong approach then corrected) — the learning is valuable
- Involves non-obvious usage of specific tools, APIs, or frameworks
- Contains debugging/troubleshooting with diagnostic reasoning
- Shows how to combine multiple tools/services to accomplish a technical goal
- Contains deployment, configuration, or infrastructure setup steps
- Demonstrates a reusable data processing or automation pipeline

NOT worth distilling (if ANY matches, return shouldGenerate=false):
- Pure factual Q&A with no process ("what is TCP", "what's the capital of France")
- Single-turn simple answers with no workflow
- Conversation too fragmented or incoherent to extract a clear process
- One-off personal tasks: identity confirmation, preference setting, self-introduction
- Casual chat, opinion discussion, news commentary, brainstorming without actionable output
- Simple information lookup or summarization (e.g. "summarize this article", "explain X concept")
- Organizing/listing personal information (work history, resume, contacts)
- Generic product/system overviews without specific operational steps
- Tasks where the "steps" are just the AI answering questions (no real workflow)

Task title: {TITLE}
Task summary:
{SUMMARY}

LANGUAGE RULE (MUST FOLLOW): Detect the language of the task title/summary. If it is Chinese, the "reason" field MUST be in Chinese. If English, reason in English. Only "suggestedName" stays in English kebab-case. 如果任务标题/摘要是中文，reason 必须用中文。

Reply in JSON only, no extra text:
{
  "shouldGenerate": boolean,
  "reason": "brief explanation (same language as input)",
  "suggestedName": "kebab-case-name",
  "suggestedTags": ["tag1", "tag2"],
  "confidence": 0.0-1.0
}`;

const UPGRADE_EVAL_PROMPT = `You are a skill upgrade evaluation expert.

Existing skill (v{VERSION}):
Name: {SKILL_NAME}
Content:
{SKILL_CONTENT}

Newly completed task:
Title: {TITLE}
Summary:
{SUMMARY}

Does the new task bring substantive improvements to the existing skill?

Worth upgrading (any one qualifies):
1. Faster — shorter path discovered
2. More elegant — cleaner, follows best practices better
3. More convenient — fewer dependencies or complexity
4. Fewer tokens — less exploration/trial-and-error needed
5. More accurate — corrects wrong parameters/steps in old skill
6. More robust — adds edge cases, error handling
7. New scenario — covers a variant the old skill didn't
8. Fixes outdated info — old skill has stale information

NOT worth upgrading:
- New task is identical to existing skill
- New task's approach is worse than existing skill
- Differences are trivial

LANGUAGE RULE: "reason" and "mergeStrategy" MUST use the SAME language as the task title/summary. Chinese input → Chinese output. English input → English output.

Reply in JSON only, no extra text:
{
  "shouldUpgrade": boolean,
  "upgradeType": "refine" | "extend" | "fix",
  "dimensions": ["faster", "more_elegant", "more_convenient", "fewer_tokens", "more_accurate", "more_robust", "new_scenario", "fix_outdated"],
  "reason": "what new value the task brings (same language as input)",
  "mergeStrategy": "which specific parts need updating (same language as input)",
  "confidence": 0.0-1.0
}`;

export class SkillEvaluator {
  constructor(private ctx: PluginContext) {}

  passesRuleFilter(chunks: Chunk[], task: Task): { pass: boolean; skipReason: string } {
    const minChunks = this.ctx.config.skillEvolution?.minChunksForEval ?? DEFAULTS.skillMinChunksForEval;
    if (chunks.length < minChunks) {
      return { pass: false, skipReason: `chunks不足 (${chunks.length} < ${minChunks})` };
    }

    if (task.status === "skipped") {
      return { pass: false, skipReason: "task状态为skipped" };
    }

    if (task.summary.length < 100) {
      return { pass: false, skipReason: `summary过短 (${task.summary.length} < 100)` };
    }

    const userChunks = chunks.filter(c => c.role === "user");
    if (userChunks.length === 0) {
      return { pass: false, skipReason: "无用户消息" };
    }

    const assistantChunks = chunks.filter(c => c.role === "assistant");
    if (assistantChunks.length === 0) {
      return { pass: false, skipReason: "无助手回复" };
    }

    return { pass: true, skipReason: "" };
  }

  async evaluateCreate(task: Task): Promise<CreateEvalResult> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) {
      return { shouldGenerate: false, reason: "no LLM configured", suggestedName: "", suggestedTags: [], confidence: 0 };
    }

    const prompt = CREATE_EVAL_PROMPT
      .replace("{TITLE}", task.title)
      .replace("{SUMMARY}", task.summary.slice(0, 3000));

    try {
      const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillEvaluator.create", { openclawAPI: this.ctx.openclawAPI });
      return this.parseJSON<CreateEvalResult>(raw, {
        shouldGenerate: false, reason: "parse failed", suggestedName: "", suggestedTags: [], confidence: 0,
      });
    } catch (err) {
      this.ctx.log.warn(`SkillEvaluator.evaluateCreate failed: ${err}`);
      return { shouldGenerate: false, reason: `error: ${err}`, suggestedName: "", suggestedTags: [], confidence: 0 };
    }
  }

  async evaluateUpgrade(task: Task, skill: Skill, skillContent: string): Promise<UpgradeEvalResult> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) {
      return { shouldUpgrade: false, upgradeType: "refine", dimensions: [], reason: "no LLM configured", mergeStrategy: "", confidence: 0 };
    }

    const prompt = UPGRADE_EVAL_PROMPT
      .replace("{VERSION}", String(skill.version))
      .replace("{SKILL_NAME}", skill.name)
      .replace("{SKILL_CONTENT}", skillContent.slice(0, 4000))
      .replace("{TITLE}", task.title)
      .replace("{SUMMARY}", task.summary.slice(0, 3000));

    try {
      const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillEvaluator.upgrade", { openclawAPI: this.ctx.openclawAPI });
      return this.parseJSON<UpgradeEvalResult>(raw, {
        shouldUpgrade: false, upgradeType: "refine", dimensions: [], reason: "parse failed", mergeStrategy: "", confidence: 0,
      });
    } catch (err) {
      this.ctx.log.warn(`SkillEvaluator.evaluateUpgrade failed: ${err}`);
      return { shouldUpgrade: false, upgradeType: "refine", dimensions: [], reason: `error: ${err}`, mergeStrategy: "", confidence: 0 };
    }
  }


  private parseJSON<T>(raw: string, fallback: T): T {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    try {
      return JSON.parse(jsonMatch[0]) as T;
    } catch {
      return fallback;
    }
  }
}
