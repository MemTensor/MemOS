import { v4 as uuid } from "uuid";
import { createHash } from "crypto";
import type { ConversationMessage, Chunk, PluginContext } from "../types";
import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import { Summarizer } from "./providers";
import { findDuplicate, findTopSimilar } from "./dedup";
import { TaskProcessor } from "./task-processor";

export class IngestWorker {
  private summarizer: Summarizer;
  private taskProcessor: TaskProcessor;
  private queue: ConversationMessage[] = [];
  private processing = false;
  private flushResolvers: Array<() => void> = [];

  constructor(
    private store: SqliteStore,
    private embedder: Embedder,
    private ctx: PluginContext,
  ) {
    const strongCfg = ctx.config.skillEvolution?.summarizer;
    this.summarizer = new Summarizer(ctx.config.summarizer, ctx.log, strongCfg);
    this.taskProcessor = new TaskProcessor(store, ctx);
  }

  getTaskProcessor(): TaskProcessor { return this.taskProcessor; }

  enqueue(messages: ConversationMessage[]): void {
    this.queue.push(...messages);
    if (!this.processing) {
      this.processQueue().catch((err) => {
        this.ctx.log.error(`Ingest worker error: ${err}`);
        this.processing = false;
      });
    }
  }

  /** Wait until all queued messages have been processed. */
  async flush(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) return;
    return new Promise((resolve) => {
      this.flushResolvers.push(resolve);
    });
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const t0 = performance.now();
        const batchSize = this.queue.length;
        let lastSessionKey: string | undefined;
        let lastOwner: string | undefined;
        let lastTimestamp = 0;
        let stored = 0;
        let skipped = 0;
        let merged = 0;
        let duplicated = 0;
        let errors = 0;
        const resultLines: string[] = [];
        const inputLines: string[] = [];

        while (this.queue.length > 0) {
          const msg = this.queue.shift()!;
          inputLines.push(`[${msg.role}] ${msg.content}`);
          try {
            const result = await this.ingestMessage(msg);
            lastSessionKey = msg.sessionKey;
            lastOwner = msg.owner ?? "agent:main";
            lastTimestamp = Math.max(lastTimestamp, msg.timestamp);
            if (result === "skipped") {
              skipped++;
              resultLines.push(`[${msg.role}] ⏭ exact-dup → ${msg.content}`);
            } else if (result.action === "stored") {
              stored++;
              resultLines.push(`[${msg.role}] ✅ stored → ${result.summary ?? msg.content}`);
            } else if (result.action === "duplicate") {
              duplicated++;
              resultLines.push(`[${msg.role}] 🔁 dedup(${result.reason ?? "similar"}) → ${msg.content}`);
            } else if (result.action === "merged") {
              merged++;
              resultLines.push(`[${msg.role}] 🔀 merged → ${msg.content}`);
            }
          } catch (err) {
            errors++;
            resultLines.push(`[${msg.role}] ❌ error → ${msg.content}`);
            this.ctx.log.error(`Failed to ingest message turn=${msg.turnId}: ${err}`);
          }
        }

        const dur = performance.now() - t0;

        if (stored + merged > 0 || skipped > 0 || duplicated > 0) {
          this.store.recordToolCall("memory_add", dur, errors === 0);
          try {
            const inputInfo = {
              session: lastSessionKey,
              messages: batchSize,
              details: inputLines,
            };
            const stats = [`stored=${stored}`, skipped > 0 ? `skipped=${skipped}` : null, duplicated > 0 ? `dedup=${duplicated}` : null, merged > 0 ? `merged=${merged}` : null, errors > 0 ? `errors=${errors}` : null].filter(Boolean).join(", ");
            this.store.recordApiLog("memory_add", inputInfo, `${stats}\n${resultLines.join("\n")}`, dur, errors === 0);
          } catch (_) { /* best-effort */ }
        }

        if (lastSessionKey) {
          this.ctx.log.debug(`Calling TaskProcessor.onChunksIngested session=${lastSessionKey} ts=${lastTimestamp} owner=${lastOwner}`);
          try {
            await this.taskProcessor.onChunksIngested(lastSessionKey, lastTimestamp, lastOwner);
          } catch (err) {
            this.ctx.log.error(`TaskProcessor post-ingest error: ${err}`);
          }
        }
      }
    } finally {
      this.processing = false;
      for (const resolve of this.flushResolvers) resolve();
      this.flushResolvers = [];
    }
  }

  private async ingestMessage(msg: ConversationMessage): Promise<
    "skipped" | { action: "stored" | "duplicate" | "merged"; summary?: string; reason?: string }
  > {
    if (this.store.chunkExistsByContent(msg.sessionKey, msg.role, msg.content)) {
      this.ctx.log.debug(`Exact-dup (same session+role+hash), skipping: session=${msg.sessionKey} role=${msg.role} len=${msg.content.length}`);
      return "skipped";
    }

    const kind = msg.role === "tool" ? "tool_result" : "paragraph";
    return await this.storeChunk(msg, msg.content, kind, 0);
  }

  private async storeChunk(
    msg: ConversationMessage,
    content: string,
    kind: Chunk["kind"],
    seq: number,
  ): Promise<{ action: "stored" | "duplicate" | "merged"; chunkId?: string; summary?: string; targetChunkId?: string; reason?: string }> {
    const chunkId = uuid();
    let summary = await this.summarizer.summarize(content);

    let embedding: number[] | null = null;
    try {
      [embedding] = await this.embedder.embed([summary]);
    } catch (err) {
      this.ctx.log.warn(`Embedding failed for chunk=${chunkId}, storing without vector: ${err}`);
    }

    let dedupStatus: "active" | "duplicate" | "merged" = "active";
    let dedupTarget: string | null = null;
    let dedupReason: string | null = null;
    let mergedFromOld: string | null = null;

    // Fast path: exact content_hash match within same owner (agent dimension)
    const chunkOwner = msg.owner ?? "agent:main";
    const existingByHash = this.store.findActiveChunkByHash(content, chunkOwner);
    if (existingByHash) {
      this.ctx.log.debug(`Exact-dup (owner=${chunkOwner}): hash match → existing=${existingByHash}`);
      this.store.recordMergeHit(existingByHash, "DUPLICATE", "exact content hash match");
      dedupStatus = "duplicate";
      dedupTarget = existingByHash;
      dedupReason = "exact content hash match";
    }

    // Smart dedup: find Top-5 similar chunks, then ask LLM to judge
    if (dedupStatus === "active" && embedding) {
      const similarThreshold = this.ctx.config.dedup?.similarityThreshold ?? 0.60;
      const dedupOwnerFilter = msg.owner ? [msg.owner] : undefined;
      const topSimilar = findTopSimilar(this.store, embedding, similarThreshold, 5, this.ctx.log, dedupOwnerFilter);

      if (topSimilar.length > 0) {
        const candidates = topSimilar.map((s, i) => {
          const chunk = this.store.getChunk(s.chunkId);
          return {
            index: i + 1,
            summary: chunk?.summary ?? "",
            chunkId: s.chunkId,
          };
        }).filter(c => c.summary);

        if (candidates.length > 0) {
          const dedupResult = await this.summarizer.judgeDedup(summary, candidates);

          if (dedupResult && dedupResult.action === "DUPLICATE" && dedupResult.targetIndex) {
            const targetChunkId = candidates[dedupResult.targetIndex - 1]?.chunkId;
            if (targetChunkId) {
              this.store.recordMergeHit(targetChunkId, "DUPLICATE", dedupResult.reason);
              dedupStatus = "duplicate";
              dedupTarget = targetChunkId;
              dedupReason = dedupResult.reason;
              this.ctx.log.debug(`Smart dedup: DUPLICATE → target=${targetChunkId}, storing with status=duplicate, reason: ${dedupResult.reason}`);
            }
          }

          if (dedupStatus === "active" && dedupResult && dedupResult.action === "UPDATE" && dedupResult.targetIndex && dedupResult.mergedSummary) {
            const targetChunkId = candidates[dedupResult.targetIndex - 1]?.chunkId;
            if (targetChunkId) {
              const oldChunk = this.store.getChunk(targetChunkId);
              const oldSummary = oldChunk?.summary ?? "";
              this.store.recordMergeHit(targetChunkId, "UPDATE", dedupResult.reason, oldSummary, dedupResult.mergedSummary);

              summary = dedupResult.mergedSummary;
              try {
                const [newEmb] = await this.embedder.embed([summary]);
                if (newEmb) embedding = newEmb;
              } catch (err) {
                this.ctx.log.warn(`Re-embed after merge failed: ${err}`);
              }

              this.store.markDedupStatus(targetChunkId, "merged", chunkId, dedupResult.reason);
              this.store.deleteEmbedding(targetChunkId);

              mergedFromOld = targetChunkId;
              dedupReason = dedupResult.reason;
              this.ctx.log.debug(`Smart dedup: UPDATE → old chunk=${targetChunkId} retired, new chunk=${chunkId} gets merged summary, reason: ${dedupResult.reason}`);
            }
          }

          if (dedupStatus === "active") {
            this.ctx.log.debug(`Smart dedup: NEW — creating active chunk (reason: ${dedupResult?.reason ?? "no_result"})`);
          }
        }
      }
    }

    const chunk: Chunk = {
      id: chunkId,
      sessionKey: msg.sessionKey,
      turnId: msg.turnId,
      seq,
      role: msg.role,
      content,
      kind,
      summary,
      embedding: null,
      taskId: null,
      skillId: null,
      owner: msg.owner ?? "agent:main",
      dedupStatus,
      dedupTarget,
      dedupReason,
      mergeCount: 0,
      lastHitAt: null,
      mergeHistory: "[]",
      createdAt: msg.timestamp,
      updatedAt: msg.timestamp,
    };

    this.store.insertChunk(chunk);
    if (embedding && dedupStatus === "active") {
      this.store.upsertEmbedding(chunkId, embedding);
    }
    this.ctx.log.debug(`Stored chunk=${chunkId} kind=${kind} role=${msg.role} dedup=${dedupStatus} len=${content.length} hasVec=${!!embedding && dedupStatus === "active"}`);

    if (dedupStatus === "duplicate") {
      return { action: "duplicate", summary, targetChunkId: dedupTarget ?? undefined, reason: dedupReason ?? undefined };
    }
    if (mergedFromOld) {
      return { action: "merged", chunkId, summary, targetChunkId: mergedFromOld, reason: dedupReason ?? undefined };
    }
    return { action: "stored", chunkId, summary };
  }
}
