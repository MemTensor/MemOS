/**
 * V7 §2.4.6 — collect decision guidance for the current retrieval.
 *
 * Inputs:
 *   - Ranked Tier-2 trace candidates (we use their `episodeId` to find
 *     the policies that share evidence with the trace).
 *   - Ranked Tier-1 skill candidates. When a skill carries its own
 *     `procedureJson.decisionGuidance`, that skill-local guidance is
 *     authoritative; we only fall back to source policies for legacy
 *     skills without embedded guidance.
 *
 * Output: a deduped list of `{ preference, antiPattern, sourcePolicyIds/sourceSkillIds }`
 * entries, ordered by frequency-of-attachment then alphabetically.
 *
 * Why dedupe at this stage and not later: a policy may surface against
 * multiple retrieved traces (typical when several traces share an
 * episode), and its `@repair {…}` block is a single coherent unit; we
 * never want to inject the same "Avoid: don't run sed -i on macOS" three
 * times.
 *
 * This is intentionally a pure function — no LLM, no network, no IO
 * beyond what the repos do. Cheap to call on every retrieval.
 */

import type { EpisodeId } from "../../agent-contract/dto.js";
import type { RankedCandidate } from "./ranker.js";
import type {
  RetrievalRepos,
  EpisodeCandidate,
  ExperienceCandidate,
  SkillCandidate,
  TraceCandidate,
} from "./types.js";

/**
 * One displayable guidance line. `kind` decides which list it goes
 * into ("preference" → 偏好 / "antiPattern" → 反模式).
 *
 * We carry `sourcePolicyIds` so the viewer (and future logs panel) can
 * link each guidance line back to the policies that justify it.
 */
export interface GuidanceLine {
  kind: "preference" | "antiPattern";
  text: string;
  sourcePolicyIds: string[];
  sourceSkillIds: string[];
}

/** What the injector needs — small, easy to render. */
export interface CollectedGuidance {
  preference: GuidanceLine[];
  antiPattern: GuidanceLine[];
  /** Policy ids consulted (for debug / logs). */
  policyIdsTouched: string[];
  /** Skill ids that contributed embedded decision guidance. */
  skillIdsTouched: string[];
}

const EMPTY: CollectedGuidance = Object.freeze({
  preference: [],
  antiPattern: [],
  policyIdsTouched: [],
  skillIdsTouched: [],
});

export interface CollectInput {
  ranked: ReadonlyArray<RankedCandidate>;
  repos: RetrievalRepos;
  /** Cap on entries kept in each list. Default 3 each — keeps prompt small. */
  perListCap?: number;
}

export function collectDecisionGuidance(input: CollectInput): CollectedGuidance {
  const { ranked, repos, perListCap = 3 } = input;
  if (ranked.length === 0) return EMPTY;

  // Gather the (episodeId, refKind) pairs we care about.
  const traceEpisodeIds = new Set<EpisodeId>();
  const policyIds = new Set<string>();
  const skillGuidance = new Map<
    string,
    { preference: string[]; antiPattern: string[] }
  >();
  for (const r of ranked) {
    const c = r.candidate;
    if (c.tier === "tier2" && c.refKind === "trace") {
      traceEpisodeIds.add((c as TraceCandidate).episodeId);
    } else if (c.tier === "tier2" && c.refKind === "episode") {
      traceEpisodeIds.add((c as EpisodeCandidate).refId);
    } else if (c.tier === "tier2" && c.refKind === "experience") {
      policyIds.add((c as ExperienceCandidate).refId);
    } else if (c.tier === "tier1") {
      const skill = c as SkillCandidate;
      if (hasGuidance(skill.decisionGuidance)) {
        skillGuidance.set(skill.refId, skill.decisionGuidance);
      } else {
        for (const id of skill.sourcePolicyIds ?? []) {
          policyIds.add(id);
        }
      }
    }
  }
  if (traceEpisodeIds.size === 0 && policyIds.size === 0 && skillGuidance.size === 0) {
    return EMPTY;
  }

  // Map each policy to {preference[], antiPattern[]} once.
  const policyGuidance = new Map<
    string,
    { preference: string[]; antiPattern: string[]; matchedEpisodes: number }
  >();
  if (repos.policies && (traceEpisodeIds.size > 0 || policyIds.size > 0)) {
    const activePolicies = repos.policies.list({ status: "active" });
    for (const p of activePolicies) {
      let matched = 0;
      for (const ep of p.sourceEpisodeIds) {
        if (traceEpisodeIds.has(ep)) matched += 1;
      }
      if (policyIds.has(p.id)) matched += 1;
      if (matched === 0) continue; // policy isn't connected to anything we retrieved

      const dg = p.decisionGuidance;
      if (dg.preference.length === 0 && dg.antiPattern.length === 0) {
        continue; // policy has no learned guidance yet
      }
      policyGuidance.set(p.id, { ...dg, matchedEpisodes: matched });
    }
  }

  if (policyGuidance.size === 0 && skillGuidance.size === 0) return EMPTY;

  // Build dedupe maps keyed by normalized text.
  const prefDedupe = new Map<string, GuidanceLine>();
  const avoidDedupe = new Map<string, GuidanceLine>();

  for (const [sid, g] of skillGuidance) {
    for (const text of g.preference) {
      const key = normaliseKey(text);
      if (!key) continue;
      const existing = prefDedupe.get(key);
      if (existing) {
        existing.sourceSkillIds.push(sid);
      } else {
        prefDedupe.set(key, {
          kind: "preference",
          text: text.trim(),
          sourcePolicyIds: [],
          sourceSkillIds: [sid],
        });
      }
    }
    for (const text of g.antiPattern) {
      const key = normaliseKey(text);
      if (!key) continue;
      const existing = avoidDedupe.get(key);
      if (existing) {
        existing.sourceSkillIds.push(sid);
      } else {
        avoidDedupe.set(key, {
          kind: "antiPattern",
          text: text.trim(),
          sourcePolicyIds: [],
          sourceSkillIds: [sid],
        });
      }
    }
  }

  for (const [pid, g] of policyGuidance) {
    for (const text of g.preference) {
      const key = normaliseKey(text);
      if (!key) continue;
      const existing = prefDedupe.get(key);
      if (existing) {
        existing.sourcePolicyIds.push(pid);
      } else {
        prefDedupe.set(key, {
          kind: "preference",
          text: text.trim(),
          sourcePolicyIds: [pid],
          sourceSkillIds: [],
        });
      }
    }
    for (const text of g.antiPattern) {
      const key = normaliseKey(text);
      if (!key) continue;
      const existing = avoidDedupe.get(key);
      if (existing) {
        existing.sourcePolicyIds.push(pid);
      } else {
        avoidDedupe.set(key, {
          kind: "antiPattern",
          text: text.trim(),
          sourcePolicyIds: [pid],
          sourceSkillIds: [],
        });
      }
    }
  }

  // Sort: more cross-policy support first, then alphabetic for stability.
  const sortByFreq = (a: GuidanceLine, b: GuidanceLine) => {
    const aSupport = a.sourcePolicyIds.length + a.sourceSkillIds.length;
    const bSupport = b.sourcePolicyIds.length + b.sourceSkillIds.length;
    if (aSupport !== bSupport) {
      return bSupport - aSupport;
    }
    return a.text.localeCompare(b.text);
  };

  return {
    preference: Array.from(prefDedupe.values()).sort(sortByFreq).slice(0, perListCap),
    antiPattern: Array.from(avoidDedupe.values()).sort(sortByFreq).slice(0, perListCap),
    policyIdsTouched: Array.from(policyGuidance.keys()),
    skillIdsTouched: Array.from(skillGuidance.keys()),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Canonical key used for dedupe — lowercase + collapse whitespace +
 * strip trailing punctuation. We don't fold near-duplicates (that's a
 * future improvement); the repair pipeline already normalises with
 * `dedupeKeep` per policy, so cross-policy duplicates are usually
 * literal repeats.
 */
function normaliseKey(s: string): string {
  const k = s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.。!！?？,，;；:：]+$/g, "")
    .trim();
  return k;
}

function hasGuidance(
  dg: { preference: string[]; antiPattern: string[] } | undefined,
): dg is { preference: string[]; antiPattern: string[] } {
  return !!dg && (dg.preference.length > 0 || dg.antiPattern.length > 0);
}
