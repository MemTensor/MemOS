import * as fs from "fs";
import * as path from "path";
import type { PluginContext } from "../types";
import { DEFAULTS } from "../types";
import { buildSkillConfigChain, callLLMWithFallback } from "../shared/llm-call";

export interface ValidationResult {
  valid: boolean;
  qualityScore: number | null;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

export class SkillValidator {
  constructor(private ctx: PluginContext) {}

  /**
   * Format validation (no LLM needed) + optional LLM quality assessment.
   * Returns combined result with score 0-10.
   */
  async validate(dirPath: string, opts?: { skipLLM?: boolean; previousContent?: string }): Promise<ValidationResult> {
    const result: ValidationResult = {
      valid: true,
      qualityScore: null,
      errors: [],
      warnings: [],
      suggestions: [],
    };

    this.validateFormat(dirPath, result);
    if (!result.valid) return result;

    if (opts?.previousContent) {
      this.regressionCheck(dirPath, opts.previousContent, result);
    }

    if (!opts?.skipLLM) {
      try {
        await this.assessQuality(dirPath, result);
      } catch (err) {
        this.ctx.log.warn(`SkillValidator: LLM quality assessment failed: ${err}`);
        result.warnings.push(`Quality assessment skipped: ${err}`);
      }
    }

    return result;
  }

  private validateFormat(dirPath: string, result: ValidationResult): void {
    const skillMdPath = path.join(dirPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      result.valid = false;
      result.errors.push("SKILL.md not found");
      return;
    }

    const content = fs.readFileSync(skillMdPath, "utf-8");
    if (!content.trim()) {
      result.valid = false;
      result.errors.push("SKILL.md is empty");
      return;
    }

    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      result.valid = false;
      result.errors.push("YAML frontmatter missing (expected --- ... ---)");
      return;
    }

    const frontmatter = fmMatch[1];

    const nameMatch = frontmatter.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (!nameMatch || !nameMatch[1].trim()) {
      result.valid = false;
      result.errors.push("Frontmatter missing 'name' field");
      return;
    }
    const name = nameMatch[1].trim();

    if (name.length > 64) {
      result.errors.push(`Name too long (${name.length} chars, max 64)`);
      result.valid = false;
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && name.length > 1) {
      result.warnings.push(`Name "${name}" is not strict kebab-case`);
    }

    const descMatch = frontmatter.match(/^description:\s*["']?([\s\S]*?)["']?\s*$/m);
    if (!descMatch || !descMatch[1].trim()) {
      result.valid = false;
      result.errors.push("Frontmatter missing 'description' field");
      return;
    }
    const desc = descMatch[1].trim();
    if (desc.length > 1024) {
      result.warnings.push(`Description too long (${desc.length} chars, max 1024)`);
    }

    const maxLines = this.ctx.config.skillEvolution?.maxSkillLines ?? DEFAULTS.skillMaxLines;
    const lineCount = content.split("\n").length;
    if (lineCount > maxLines) {
      result.warnings.push(`Content exceeds ${maxLines} lines (has ${lineCount})`);
    }

    if (content.length < 200) {
      result.warnings.push("Content seems very short (< 200 chars)");
    }
  }

  /**
   * Check that an upgrade doesn't lose significant content from the previous version.
   */
  private regressionCheck(dirPath: string, previousContent: string, result: ValidationResult): void {
    const skillMdPath = path.join(dirPath, "SKILL.md");
    const newContent = fs.readFileSync(skillMdPath, "utf-8");

    const prevLines = previousContent.split("\n").length;
    const newLines = newContent.split("\n").length;

    if (newLines < prevLines * 0.7 && prevLines > 20) {
      result.warnings.push(
        `Content shrank significantly: ${prevLines} → ${newLines} lines (${Math.round((1 - newLines / prevLines) * 100)}% reduction)`,
      );
    }

    const prevSections = (previousContent.match(/^##\s+.+$/gm) || []).map(s => s.replace(/^##\s+/, "").trim().toLowerCase());
    const newSections = (newContent.match(/^##\s+.+$/gm) || []).map(s => s.replace(/^##\s+/, "").trim().toLowerCase());
    const missingSections = prevSections.filter(s => !newSections.some(ns => ns.includes(s) || s.includes(ns)));
    if (missingSections.length > 0) {
      result.warnings.push(`Sections may have been lost: ${missingSections.join(", ")}`);
    }
  }

  private async assessQuality(dirPath: string, result: ValidationResult): Promise<void> {
    const chain = buildSkillConfigChain(this.ctx);
    if (chain.length === 0) return;

    const skillMdPath = path.join(dirPath, "SKILL.md");
    const content = fs.readFileSync(skillMdPath, "utf-8");

    const prompt = QUALITY_PROMPT.replace("{SKILL_CONTENT}", content.slice(0, 6000));

    try {
      const raw = await callLLMWithFallback(chain, prompt, this.ctx.log, "SkillValidator.quality");

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const assessment = JSON.parse(jsonMatch[0]) as {
        score: number;
        strengths: string[];
        weaknesses: string[];
        suggestions: string[];
      };

      result.qualityScore = Math.max(0, Math.min(10, assessment.score));
      if (assessment.suggestions) {
        result.suggestions.push(...assessment.suggestions);
      }
      if (assessment.weaknesses) {
        result.warnings.push(...assessment.weaknesses);
      }

      if (result.qualityScore < 6) {
        result.warnings.push(`Quality score ${result.qualityScore}/10 is below threshold, marked as draft`);
      }
    } catch (err) {
      this.ctx.log.warn(`SkillValidator: quality assessment failed: ${err}`);
    }
  }
}

const QUALITY_PROMPT = `You are a skill quality reviewer. Evaluate the following SKILL.md and give a score from 0 to 10.

Criteria:
1. Clarity: Are the steps clear and actionable? (0-2 pts)
2. Completeness: Does it cover scenarios, pitfalls, and key code? (0-2 pts)
3. Reusability: Can this skill be applied to similar future tasks? (0-2 pts)
4. Accuracy: Are commands, code, and configurations correct? (0-2 pts)
5. Structure: Is the format well-organized with proper sections? (0-2 pts)

SKILL.md:
{SKILL_CONTENT}

LANGUAGE RULE: "strengths", "weaknesses", and "suggestions" MUST use the SAME language as the SKILL.md content. Chinese skill → Chinese feedback. English skill → English feedback.

Reply in JSON only:
{
  "score": 0-10,
  "strengths": ["what's good (same language as skill)"],
  "weaknesses": ["what's lacking (same language as skill)"],
  "suggestions": ["how to improve (same language as skill)"]
}`;
