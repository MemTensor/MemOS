import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import type { PluginContext, SearchHit, SearchResult, SkillSearchHit, Skill } from "../types";
import { vectorSearch, cosineSimilarity } from "../storage/vector";
import { rrfFuse } from "./rrf";
import { mmrRerank } from "./mmr";
import { applyRecencyDecay } from "./recency";
import { Summarizer } from "../ingest/providers";

export type SkillSearchScope = "mix" | "self" | "public";

export interface RecallOptions {
  query?: string;
  maxResults?: number;
  minScore?: number;
  role?: string;
  ownerFilter?: string[];
}

const MAX_RECENT_QUERIES = 20;

export class RecallEngine {
  private recentQueries: Array<{ query: string; maxResults: number; minScore: number; hitCount: number }> = [];

  constructor(
    private store: SqliteStore,
    private embedder: Embedder,
    private ctx: PluginContext,
  ) {}

  async search(opts: RecallOptions): Promise<SearchResult> {
    const recallCfg = this.ctx.config.recall!;
    const maxResults = Math.min(
      opts.maxResults ?? recallCfg.maxResultsDefault!,
      recallCfg.maxResultsMax!,
    );
    const minScore = opts.minScore ?? recallCfg.minScoreDefault!;
    const query = opts.query ?? "";
    const roleFilter = opts.role;

    const repeatNote = this.checkRepeat(query, maxResults, minScore);
    const candidatePool = maxResults * 5;
    const ownerFilter = opts.ownerFilter;

    // Step 1: Gather candidates from FTS, vector search, and pattern search
    const ftsCandidates = query
      ? this.store.ftsSearch(query, candidatePool, ownerFilter)
      : [];

    let vecCandidates: Array<{ chunkId: string; score: number }> = [];
    if (query) {
      try {
        const queryVec = await this.embedder.embedQuery(query);
        const maxChunks = recallCfg.vectorSearchMaxChunks && recallCfg.vectorSearchMaxChunks > 0
          ? recallCfg.vectorSearchMaxChunks
          : undefined;
        vecCandidates = vectorSearch(this.store, queryVec, candidatePool, maxChunks, ownerFilter);
      } catch (err) {
        this.ctx.log.warn(`Vector search failed, using FTS only: ${err}`);
      }
    }

    // Step 1b: Pattern search (LIKE-based) as fallback for short terms that
    // trigram FTS cannot match (trigram requires >= 3 chars).
    // For CJK text without spaces, extract bigrams (2-char sliding windows)
    // so that queries like "唐波是谁" produce ["唐波", "波是", "是谁"].
    const cleaned = query.replace(/[."""(){}[\]*:^~!@#$%&\\/<>,;'`?？。，！、：""''（）【】《》]/g, " ");
    const spaceSplit = cleaned.split(/\s+/).filter((t) => t.length === 2);
    const cjkBigrams: string[] = [];
    const cjkRuns = cleaned.match(/[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]{2,}/g);
    if (cjkRuns) {
      for (const run of cjkRuns) {
        for (let i = 0; i <= run.length - 2; i++) {
          cjkBigrams.push(run.slice(i, i + 2));
        }
      }
    }
    const shortTerms = [...new Set([...spaceSplit, ...cjkBigrams])];
    const patternHits = shortTerms.length > 0
      ? this.store.patternSearch(shortTerms, { limit: candidatePool, ownerFilter })
      : [];
    const patternRanked = patternHits.map((h, i) => ({
      id: h.chunkId,
      score: 1 / (i + 1),
    }));

    // Step 1c: Hub memories — FTS + pattern + cached embeddings (same strategy as chunks/skills).
    let hubMemFtsRanked: Array<{ id: string; score: number }> = [];
    let hubMemVecRanked: Array<{ id: string; score: number }> = [];
    let hubMemPatternRanked: Array<{ id: string; score: number }> = [];
    if (query && this.ctx.config.sharing?.enabled && this.ctx.config.sharing.role === "hub") {
      try {
        const hubFtsHits = this.store.searchHubMemories(query, { maxResults: candidatePool });
        hubMemFtsRanked = hubFtsHits.map(({ hit }, i) => ({ id: `hubmem:${hit.id}`, score: 1 / (i + 1) }));
      } catch { /* hub_memories table may not exist */ }
      if (shortTerms.length > 0) {
        try {
          const hubPatternHits = this.store.hubMemoryPatternSearch(shortTerms, { limit: candidatePool });
          hubMemPatternRanked = hubPatternHits.map((h, i) => ({ id: `hubmem:${h.memoryId}`, score: 1 / (i + 1) }));
        } catch { /* best-effort */ }
      }

      try {
        const qv = await this.embedder.embedQuery(query).catch(() => null);
        if (qv) {
          const memEmbs = this.store.getVisibleHubMemoryEmbeddings("__hub__");
          const scored: Array<{ id: string; score: number }> = [];
          for (const e of memEmbs) {
            let dot = 0, nA = 0, nB = 0;
            const len = Math.min(qv.length, e.vector.length);
            for (let i = 0; i < len; i++) {
              dot += qv[i] * e.vector[i]; nA += qv[i] * qv[i]; nB += e.vector[i] * e.vector[i];
            }
            const sim = nA > 0 && nB > 0 ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
            if (sim > 0.3) scored.push({ id: `hubmem:${e.memoryId}`, score: sim });
          }
          scored.sort((a, b) => b.score - a.score);
          hubMemVecRanked = scored.slice(0, candidatePool);
        }
      } catch { /* best-effort */ }

      const hubTotal = hubMemFtsRanked.length + hubMemVecRanked.length + hubMemPatternRanked.length;
      if (hubTotal > 0) {
        this.ctx.log.debug(`recall: hub_memories candidates: fts=${hubMemFtsRanked.length}, vec=${hubMemVecRanked.length}, pattern=${hubMemPatternRanked.length}`);
      }
    }

    // Step 2: RRF fusion
    const ftsRanked = ftsCandidates.map((c) => ({ id: c.chunkId, score: c.score }));
    const vecRanked = vecCandidates.map((c) => ({ id: c.chunkId, score: c.score }));
    const allRankedLists = [ftsRanked, vecRanked, patternRanked];
    if (hubMemFtsRanked.length > 0) allRankedLists.push(hubMemFtsRanked);
    if (hubMemVecRanked.length > 0) allRankedLists.push(hubMemVecRanked);
    if (hubMemPatternRanked.length > 0) allRankedLists.push(hubMemPatternRanked);
    const rrfScores = rrfFuse(allRankedLists, recallCfg.rrfK);

    if (rrfScores.size === 0) {
      this.recordQuery(query, maxResults, minScore, 0);
      return {
        hits: [],
        meta: {
          usedMinScore: minScore,
          usedMaxResults: maxResults,
          totalCandidates: 0,
          note: repeatNote ?? "No candidates found for the given query.",
        },
      };
    }

    // Step 3: MMR re-ranking
    const rrfList = [...rrfScores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);

    const mmrResults = mmrRerank(rrfList, this.store, recallCfg.mmrLambda, maxResults * 2);

    // Step 4: Time decay
    const withTs = mmrResults.map((r) => {
      if (r.id.startsWith("hubmem:")) {
        const memId = r.id.slice(7);
        const mem = this.store.getHubMemoryById(memId);
        return { ...r, createdAt: mem?.createdAt ?? 0 };
      }
      const chunk = this.store.getChunk(r.id);
      return { ...r, createdAt: chunk?.createdAt ?? 0 };
    });
    const decayed = applyRecencyDecay(withTs, recallCfg.recencyHalfLifeDays);

    // Step 5: Apply relative threshold on raw scores, then normalize to [0,1]
    const sorted = [...decayed].sort((a, b) => b.score - a.score);
    const topScore = sorted.length > 0 ? sorted[0].score : 0;

    const absoluteFloor = topScore * minScore * 0.3;
    // When role filter is active, keep a larger pool before slicing so we don't
    // discard target-role candidates that rank below non-target ones.
    const preSliceLimit = roleFilter ? maxResults * 5 : maxResults;
    const filtered = sorted
      .filter((d) => d.score >= absoluteFloor)
      .slice(0, preSliceLimit);

    const displayMax = filtered.length > 0 ? filtered[0].score : 1;
    const normalized = filtered.map((d) => ({
      ...d,
      score: d.score / displayMax,
    }));

    // Step 6: Build hits (with optional role filter), applying maxResults cap at the end
    const hits: SearchHit[] = [];
    for (const candidate of normalized) {
      if (hits.length >= maxResults) break;

      if (candidate.id.startsWith("hubmem:")) {
        const memId = candidate.id.slice(7);
        const mem = this.store.getHubMemoryById(memId);
        if (!mem) continue;
        if (roleFilter && mem.role !== roleFilter) continue;
        hits.push({
          summary: mem.summary || mem.content.slice(0, 200),
          original_excerpt: mem.content,
          ref: {
            sessionKey: `hub-shared:${mem.sourceUserId}`,
            chunkId: mem.id,
            turnId: "",
            seq: 0,
          },
          score: Math.round(candidate.score * 1000) / 1000,
          taskId: null,
          skillId: null,
          owner: `hub-user:${mem.sourceUserId}`,
          origin: "hub-memory",
          source: {
            ts: mem.createdAt,
            role: (mem.role || "assistant") as any,
            sessionKey: `hub-shared:${mem.sourceUserId}`,
          },
        });
        continue;
      }

      const chunk = this.store.getChunk(candidate.id);
      if (!chunk) continue;
      if (roleFilter && chunk.role !== roleFilter) continue;

      const excerpt = (chunk.mergeCount ?? 0) > 0 ? chunk.summary : makeExcerpt(chunk.content);
      hits.push({
        summary: chunk.summary,
        original_excerpt: excerpt,
        ref: {
          sessionKey: chunk.sessionKey,
          chunkId: chunk.id,
          turnId: chunk.turnId,
          seq: chunk.seq,
        },
        score: Math.round(candidate.score * 1000) / 1000,
        taskId: chunk.taskId,
        skillId: chunk.skillId,
        owner: chunk.owner,
        origin: chunk.owner === "public" ? "local-shared" : "local",
        source: {
          ts: chunk.createdAt,
          role: chunk.role,
          sessionKey: chunk.sessionKey,
        },
      });
    }

    this.recordQuery(query, maxResults, minScore, hits.length);

    return {
      hits,
      meta: {
        usedMinScore: minScore,
        usedMaxResults: maxResults,
        totalCandidates: rrfScores.size,
        ...(repeatNote ? { note: repeatNote } : {}),
      },
    };
  }

  /**
   * PRD §6.1: Detect repeated identical/similar queries and produce a
   * warning note so the model knows to vary its approach.
   */
  private checkRepeat(query: string, maxResults: number, minScore: number): string | undefined {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return undefined;

    const dup = this.recentQueries.find(
      (q) => q.query === normalized && q.maxResults === maxResults && q.minScore === minScore,
    );

    if (dup) {
      if (dup.hitCount === 0) {
        return "This exact query with the same parameters was already tried and returned 0 results. Try rephrasing with different keywords, or adjust maxResults/minScore.";
      }
      return "This exact query with the same parameters was already executed. Consider varying the query or expanding parameters to get different results.";
    }

    return undefined;
  }

  private recordQuery(query: string, maxResults: number, minScore: number, hitCount: number): void {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return;

    this.recentQueries = this.recentQueries.filter(
      (q) => !(q.query === normalized && q.maxResults === maxResults && q.minScore === minScore),
    );
    this.recentQueries.push({ query: normalized, maxResults, minScore, hitCount });

    if (this.recentQueries.length > MAX_RECENT_QUERIES) {
      this.recentQueries.shift();
    }
  }

  async searchSkills(query: string, scope: SkillSearchScope, currentOwner: string): Promise<SkillSearchHit[]> {
    const RRF_K = 60;
    const TOP_CANDIDATES = 20;

    // FTS on name + description
    const ftsCandidates = this.store.skillFtsSearch(query, TOP_CANDIDATES, scope, currentOwner);

    // Vector search on description embedding
    let vecCandidates: Array<{ skillId: string; score: number }> = [];
    try {
      const queryVec = await this.embedder.embedQuery(query);
      const allEmb = this.store.getSkillEmbeddings(scope, currentOwner);
      vecCandidates = allEmb.map((row) => ({
        skillId: row.skillId,
        score: cosineSimilarity(queryVec, row.vector),
      }));
      vecCandidates.sort((a, b) => b.score - a.score);
      vecCandidates = vecCandidates.slice(0, TOP_CANDIDATES);
    } catch (err) {
      this.ctx.log.warn(`Skill vector search failed, using FTS only: ${err}`);
    }

    // RRF fusion
    const ftsRanked = ftsCandidates.map((c) => ({ id: c.skillId, score: c.score }));
    const vecRanked = vecCandidates.map((c) => ({ id: c.skillId, score: c.score }));
    const rrfScores = rrfFuse([ftsRanked, vecRanked], RRF_K);

    if (rrfScores.size === 0) return [];

    const sorted = [...rrfScores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_CANDIDATES);

    // Load skill details for LLM judgment
    const candidateSkills: Array<{ skill: Skill; rrfScore: number }> = [];
    for (const item of sorted) {
      const skill = this.store.getSkill(item.id);
      if (skill) candidateSkills.push({ skill, rrfScore: item.score });
    }

    if (candidateSkills.length === 0) return [];

    // LLM relevance judgment
    const summarizer = new Summarizer(this.ctx.config.summarizer, this.ctx.log, this.ctx.openclawAPI);
    const relevantIndices = await this.judgeSkillRelevance(summarizer, query, candidateSkills);

    return relevantIndices.map((idx) => {
      const { skill, rrfScore } = candidateSkills[idx];
      return {
        skillId: skill.id,
        name: skill.name,
        description: skill.description,
        owner: skill.owner,
        visibility: skill.visibility,
        score: rrfScore,
        reason: "relevant",
      };
    });
  }

  private async judgeSkillRelevance(
    summarizer: Summarizer,
    query: string,
    candidates: Array<{ skill: Skill; rrfScore: number }>,
  ): Promise<number[]> {
    const candidateList = candidates.map((c, i) => ({
      index: i,
      role: "skill" as const,
      content: `[${c.skill.name}] ${c.skill.description}`,
    }));

    try {
      const result = await summarizer.filterRelevant(query, candidateList);
      if (result && result.relevant.length > 0) {
        return result.relevant.map((r) => r);
      }
    } catch (err) {
      this.ctx.log.warn(`Skill relevance judgment failed, returning all: ${err}`);
    }

    // Fallback: return all candidates
    return candidates.map((_, i) => i);
  }
}

function makeExcerpt(content: string): string {
  return content;
}
