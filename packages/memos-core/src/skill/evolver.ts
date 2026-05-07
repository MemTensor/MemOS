import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "../storage/sqlite";
import type { RecallEngine } from "../recall/engine";
import type { Embedder } from "../embedding";
import { cosineSimilarity } from "../storage/vector";
import type { Task, Skill, Chunk, PluginContext } from "../types";
import { DEFAULTS } from "../types";
import { SkillEvaluator } from "./evaluator";
import { SkillGenerator } from "./generator";
import { SkillUpgrader } from "./upgrader";
import { SkillInstaller, type SkillInstallMode } from "./installer";
import { buildSkillConfigChain, callLLMWithFallback } from "../shared/llm-call";

export type SkillEvolvedCallback = (skillName: string, upgradeType: "created" | "upgraded") => void;

export class SkillEvolver {
  private evaluator: SkillEvaluator;
  private generator: SkillGenerator;
  private upgrader: SkillUpgrader;
  private installer: SkillInstaller;
  private processing = false;
  private queue: Task[] = [];
  onSkillEvolved: SkillEvolvedCallback | null = null;

  constructor(
    private store: SqliteStore,
    private engine: RecallEngine,
    private ctx: PluginContext,
    private embedder?: Embedder,
  ) {
    this.evaluator = new SkillEvaluator(ctx);
    this.generator = new SkillGenerator(store, engine, ctx, embedder);
    this.upgrader = new SkillUpgrader(store, ctx);
    this.installer = new SkillInstaller(store, ctx);
  }

  async recoverOrphanedTasks(): Promise<number> {
    const orphaned = this.store.getTasksBySkillStatus(["queued", "generating"]);
    if (orphaned.length === 0) return 0;

    this.ctx.log.info(`SkillEvolver: recovering ${orphaned.length} orphaned tasks (queued/generating from previous run)`);
    for (const task of orphaned) {
      try {
        await this.processOne(task);
      } catch (err) {
        this.ctx.log.error(`SkillEvolver: recovery failed for task ${task.id}: ${err}`);
      }
    }
    return orphaned.length;
  }

  async onTaskCompleted(task: Task): Promise<void> {
    const enabled = this.ctx.config.skillEvolution?.enabled ?? DEFAULTS.skillEvolutionEnabled;
    const autoEval = this.ctx.config.skillEvolution?.autoEvaluate ?? DEFAULTS.skillAutoEvaluate;
    if (!enabled || !autoEval) return;

    if (this.processing) {
      this.ctx.log.debug(`SkillEvolver: busy, queuing task ${task.id} (queue=${this.queue.length})`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "queued", skillReason: `排队中，前方还有 ${this.queue.length + 1} 个任务` });
      this.queue.push(task);
      return;
    }
    await this.drain(task);
  }

  private async drain(task: Task): Promise<void> {
    this.processing = true;
    try {
      await this.processOne(task);
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await this.processOne(next);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processOne(task: Task): Promise<void> {
    try {
      await this.process(task);
    } catch (err) {
      this.ctx.log.error(`SkillEvolver error for task ${task.id}: ${err}`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "skipped", skillReason: `Error: ${err}` });
    }
  }

  private async process(task: Task): Promise<void> {
    const chunks = this.store.getChunksByTask(task.id);

    const { pass, skipReason } = this.evaluator.passesRuleFilter(chunks, task);
    if (!pass) {
      this.ctx.log.debug(`SkillEvolver: task ${task.id} skipped by rule filter: ${skipReason} (chunks=${chunks.length})`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "skipped", skillReason: skipReason });
      return;
    }

    const preferUpgrade = this.ctx.config.skillEvolution?.preferUpgradeExisting ?? DEFAULTS.skillPreferUpgrade;
    const relatedSkill = await this.findRelatedSkill(task);

    if (relatedSkill) {
      await this.handleExistingSkill(task, chunks, relatedSkill);
    } else if (preferUpgrade) {
      const nameCandidate = await this.findSkillByNameSimilarity(task);
      if (nameCandidate) {
        this.ctx.log.info(`SkillEvolver: preferUpgrade found name-similar skill "${nameCandidate.name}" for task "${task.title}"`);
        await this.handleExistingSkill(task, chunks, nameCandidate);
      } else {
        await this.handleNewSkill(task, chunks);
      }
    } else {
      await this.handleNewSkill(task, chunks);
    }
  }

  /** Max candidates to send to LLM for relevance judgment. */
  private static readonly RELATED_SKILL_CANDIDATE_TOP = 10;

  /**
   * Search for an existing skill that is HIGHLY related to the given task.
   *
   * 1. Collect top 50 skill candidates by FTS + vector similarity (relaxed thresholds).
   * 2. Call LLM with task title/summary and each skill's name/description; strict rule:
   *    only output ONE skill index if the task clearly belongs to that skill's domain;
   *    otherwise output 0 (do not force a match).
   */
  private async findRelatedSkill(task: Task): Promise<Skill | null> {
    const query = task.summary.slice(0, 600);
    const owner = task.owner ?? "agent:main";
    // Relaxed thresholds to gather a larger candidate pool; LLM will do strict filtering
    const VEC_FLOOR = 0.35;
    const TOP_N = SkillEvolver.RELATED_SKILL_CANDIDATE_TOP;

    type Candidate = { skill: Skill; vecScore: number; ftsScore: number; combined: number };
    const candidateMap = new Map<string, Candidate>();

    // 1. FTS on skill name + description (take more candidates)
    try {
      const ftsHits = this.store.skillFtsSearch(query, TOP_N, "mix", owner);
      for (const hit of ftsHits) {
        const skill = this.store.getSkill(hit.skillId);
        if (skill && (skill.status === "active" || skill.status === "draft")) {
          candidateMap.set(skill.id, { skill, vecScore: 0, ftsScore: hit.score, combined: 0 });
        }
      }
    } catch (err) {
      this.ctx.log.warn(`SkillEvolver: skill FTS search failed: ${err}`);
    }

    // 2. Vector similarity: include all skills above a low floor to rank them
    if (this.embedder) {
      try {
        const queryVec = await this.embedder.embedQuery(query);
        const allSkillEmb = this.store.getSkillEmbeddings("mix", owner);
        for (const row of allSkillEmb) {
          const sim = cosineSimilarity(queryVec, row.vector);
          if (sim >= VEC_FLOOR) {
            const existing = candidateMap.get(row.skillId);
            if (existing) {
              existing.vecScore = sim;
            } else {
              const skill = this.store.getSkill(row.skillId);
              if (skill && (skill.status === "active" || skill.status === "draft")) {
                candidateMap.set(skill.id, { skill, vecScore: sim, ftsScore: 0, combined: 0 });
              }
            }
          }
        }
      } catch (err) {
        this.ctx.log.warn(`SkillEvolver: skill vector search failed: ${err}`);
      }
    }

    if (candidateMap.size === 0) return null;

    for (const c of candidateMap.values()) {
      c.combined = c.vecScore * 0.7 + c.ftsScore * 0.3;
    }

    const sorted = [...candidateMap.values()]
      .sort((a, b) => b.combined - a.combined)
      .slice(0, TOP_N);

    if (sorted.length === 0) return null;

    // 3. LLM strict relevance judgment: only one skill if HIGHLY related, else none
    const selectedSkill = await this.judgeSkillRelatedToTask(task, sorted);
    if (selectedSkill) {
      this.ctx.log.debug(`SkillEvolver: LLM selected related skill "${selectedSkill.name}" for task "${task.title}"`);
    } else {
      this.ctx.log.debug(`SkillEvolver: LLM found no highly related skill for task "${task.title}" (${sorted.length} candidates)`);
    }
    return selectedSkill;
  }

  /**
   * Ask LLM to pick at most ONE skill that is HIGHLY relevant to the task.
   * Strict rule: only return a skill if the task clearly belongs to that skill's domain; otherwise return null.
   */
  private async judgeSkillRelatedToTask(
    task: Task,
    candidates: Array<{ skill: Skill; vecScore: number; ftsScore: number; combined: number }>,
  ): Promise<Skill | null> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) {
      this.ctx.log.warn("SkillEvolver: no LLM config available, skipping skill relevance judgment");
      return null;
    }

    const taskTitle = task.title || "(no title)";
    const taskSummary = task.summary.slice(0, 800);
    const skillList = candidates
      .map((c, i) => `${i + 1}. [${c.skill.name}]\n   ${(c.skill.description || "").slice(0, 300)}`)
      .join("\n\n");

    const prompt = `You are a strict judge: decide whether a completed TASK should be merged into an EXISTING SKILL. The task and the skill must be in the SAME domain/topic — e.g. same type of problem, same tool, same workflow. Loose or tangential relevance is NOT enough.

TASK TITLE: ${taskTitle}

TASK SUMMARY:
${taskSummary}

CANDIDATE SKILLS (index, name, description):
${skillList}

RULES:
- Output exactly ONE skill index (1 to ${candidates.length}) ONLY if the task's experience clearly belongs to that skill's domain. Same topic, same kind of work.
- If no skill is clearly relevant (different domain, or only loosely related), output 0. When in doubt, output 0.
- Do not force a match. "Movie recommendation" task must not match "Weather query" or "Legal discussion" skill even if both exist in the list.

LANGUAGE RULE: "reason" MUST use the SAME language as the task title/summary. Chinese input → Chinese reason.

Reply with JSON only, no other text:
{"selectedIndex": 0, "reason": "brief explanation (same language as input)"}
Use selectedIndex 0 when none is highly relevant.`;

    try {
      const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillEvolver.judgeRelated", { temperature: 0, maxTokens: 256 });
      const parsed = this.parseJudgeSkillResult(raw, candidates.length);
      if (parsed.selectedIndex >= 1 && parsed.selectedIndex <= candidates.length) {
        return candidates[parsed.selectedIndex - 1].skill;
      }
      return null;
    } catch (err) {
      this.ctx.log.warn(`SkillEvolver: LLM skill relevance judgment failed: ${err}`);
      return null;
    }
  }

  private parseJudgeSkillResult(raw: string, maxIndex: number): { selectedIndex: number; reason: string } {
    const fallback = { selectedIndex: 0, reason: "parse failed" };
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      const obj = JSON.parse(match[0]) as { selectedIndex?: number; reason?: string };
      const idx = typeof obj.selectedIndex === "number" ? obj.selectedIndex : 0;
      const reason = typeof obj.reason === "string" ? obj.reason : "";
      if (idx < 0 || idx > maxIndex) return { selectedIndex: 0, reason: reason || "out of range" };
      return { selectedIndex: idx, reason };
    } catch {
      return fallback;
    }
  }

  private async handleExistingSkill(task: Task, chunks: Chunk[], skill: Skill): Promise<void> {
    // Verify skill still exists in DB (may have been manually deleted)
    const freshSkill = this.store.getSkill(skill.id);
    if (!freshSkill) {
      this.ctx.log.warn(`SkillEvolver: skill "${skill.name}" (${skill.id}) no longer exists, treating as new`);
      await this.handleNewSkill(task, chunks);
      return;
    }

    const skillContent = this.readSkillContent(freshSkill);
    if (!skillContent) {
      this.ctx.log.warn(`SkillEvolver: cannot read skill "${freshSkill.name}" content, treating as new`);
      await this.handleNewSkill(task, chunks);
      return;
    }

    const minConfidence = this.ctx.config.skillEvolution?.minConfidence ?? DEFAULTS.skillMinConfidence;
    const evalResult = await this.evaluator.evaluateUpgrade(task, freshSkill, skillContent);

    if (evalResult.shouldUpgrade && evalResult.confidence >= minConfidence) {
      this.ctx.log.info(`SkillEvolver: upgrading skill "${freshSkill.name}" — ${evalResult.reason}`);
      const { upgraded } = await this.upgrader.upgrade(task, freshSkill, evalResult);

      this.markChunksWithSkill(chunks, freshSkill.id);

      if (upgraded) {
        this.store.linkTaskSkill(task.id, freshSkill.id, "evolved_from", freshSkill.version + 1);
        if (freshSkill.installed) {
          this.installer.syncIfInstalled(freshSkill.name);
        } else {
          this.autoInstallIfNeeded(freshSkill);
        }
        this.onSkillEvolved?.(freshSkill.name, "upgraded");
      } else {
        this.store.linkTaskSkill(task.id, freshSkill.id, "applied_to", freshSkill.version);
      }
    } else if (evalResult.confidence < 0.3) {
      this.ctx.log.info(
        `SkillEvolver: skill "${freshSkill.name}" has low relevance (confidence=${evalResult.confidence}), ` +
        `falling back to new skill evaluation for task "${task.title}"`,
      );
      await this.handleNewSkill(task, chunks);
    } else {
      this.ctx.log.debug(`SkillEvolver: skill "${freshSkill.name}" not worth upgrading (confidence=${evalResult.confidence})`);
      this.markChunksWithSkill(chunks, freshSkill.id);
      this.store.linkTaskSkill(task.id, freshSkill.id, "applied_to", freshSkill.version);
    }
  }

  private async handleNewSkill(task: Task, chunks: Chunk[]): Promise<void> {
    const minConfidence = this.ctx.config.skillEvolution?.minConfidence ?? DEFAULTS.skillMinConfidence;
    const evalResult = await this.evaluator.evaluateCreate(task);

    if (evalResult.shouldGenerate && evalResult.confidence >= minConfidence) {
      const existingByName = this.store.getSkillByName(evalResult.suggestedName);
      if (existingByName && (existingByName.status === "active" || existingByName.status === "draft")) {
        this.ctx.log.info(`SkillEvolver: skill "${evalResult.suggestedName}" already exists, redirecting to upgrade instead of create`);
        await this.handleExistingSkill(task, chunks, existingByName);
        return;
      }

      this.ctx.log.info(`SkillEvolver: generating new skill "${evalResult.suggestedName}" — ${evalResult.reason}`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "generating", skillReason: evalResult.reason });

      const skill = await this.generator.generate(task, chunks, evalResult);
      this.markChunksWithSkill(chunks, skill.id);
      this.store.linkTaskSkill(task.id, skill.id, "generated_from", 1);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "generated", skillReason: evalResult.reason });
      this.onSkillEvolved?.(skill.name, "created");

      this.autoInstallIfNeeded(skill);
    } else {
      const reason = evalResult.reason || `confidence不足 (${evalResult.confidence} < ${minConfidence})`;
      this.ctx.log.debug(`SkillEvolver: task "${task.title}" not worth generating skill — ${reason}`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "not_generated", skillReason: reason });
    }
  }

  private markChunksWithSkill(chunks: Chunk[], skillId: string): void {
    for (const chunk of chunks) {
      this.store.setChunkSkillId(chunk.id, skillId);
    }
    this.ctx.log.debug(`SkillEvolver: marked ${chunks.length} chunks with skill_id=${skillId}`);
  }

  private async findSkillByNameSimilarity(task: Task): Promise<Skill | null> {
    const query = task.title.slice(0, 200);
    const owner = task.owner ?? "agent:main";

    try {
      const ftsHits = this.store.skillFtsSearch(query, 5, "mix", owner);
      for (const hit of ftsHits) {
        if (hit.score < 0.5) continue;
        const skill = this.store.getSkill(hit.skillId);
        if (skill && (skill.status === "active" || skill.status === "draft")) {
          return skill;
        }
      }
    } catch { /* best-effort */ }

    return null;
  }

  private autoInstallIfNeeded(skill: Skill): void {
    if (skill.status !== "active") return;

    const explicitAutoInstall = this.ctx.config.skillEvolution?.autoInstall ?? DEFAULTS.skillAutoInstall;
    if (explicitAutoInstall) {
      this.installer.install(skill.id);
      this.ctx.log.info(`SkillEvolver: auto-installed "${skill.name}" (explicit autoInstall=true)`);
      return;
    }

    const manifest = SkillInstaller.buildManifest(skill.dirPath, !!skill.installed, skill.name);
    if (manifest.installMode === "install_recommended") {
      this.installer.install(skill.id);
      this.ctx.log.info(`SkillEvolver: auto-installed "${skill.name}" (install_recommended: ${manifest.scriptsCount} scripts, ${Math.round(manifest.totalSize / 1024)}KB)`);
    }
  }

  private readSkillContent(skill: Skill): string | null {
    const filePath = path.join(skill.dirPath, "SKILL.md");
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch { /* fall through */ }
    const sv = this.store.getLatestSkillVersion(skill.id);
    return sv?.content ?? null;
  }
}
