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
    this.summarizer = new Summarizer(ctx.config.summarizer, ctx.log);
    this.taskProcessor = new TaskProcessor(store, ctx);
  }

  getTaskProcessor(): TaskProcessor { return this.taskProcessor; }

  private static isEphemeralSession(sessionKey: string): boolean {
    return sessionKey.startsWith("temp:") || sessionKey.startsWith("internal:") || sessionKey.startsWith("system:");
  }

  enqueue(messages: ConversationMessage[]): void {
    const filtered = messages.filter((m) => !IngestWorker.isEphemeralSession(m.sessionKey));
    if (filtered.length === 0) return;
    this.queue.push(...filtered);
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
        const inputDetails: Array<{ role: string; content: string }> = [];

        while (this.queue.length > 0) {
          const msg = this.queue.shift()!;
          inputDetails.push({ role: msg.role, content: msg.content });
          try {
            const result = await this.ingestMessage(msg);
            lastSessionKey = msg.sessionKey;
            lastOwner = msg.owner ?? "agent:main";
            lastTimestamp = Math.max(lastTimestamp, msg.timestamp);
            if (result === "skipped") {
              skipped++;
              resultLines.push(JSON.stringify({ role: msg.role, action: "exact-dup", summary: "", content: msg.content }));
            } else if (result.action === "stored") {
              stored++;
              resultLines.push(JSON.stringify({ role: msg.role, action: "stored", summary: result.summary ?? "", content: msg.content }));
            } else if (result.action === "duplicate") {
              duplicated++;
              resultLines.push(JSON.stringify({ role: msg.role, action: "dedup", reason: result.reason ?? "similar", summary: result.summary ?? "", content: msg.content }));
            } else if (result.action === "merged") {
              merged++;
              resultLines.push(JSON.stringify({ role: msg.role, action: "merged", summary: result.summary ?? "", content: msg.content }));
            }
          } catch (err) {
            errors++;
            resultLines.push(JSON.stringify({ role: msg.role, action: "error", summary: "", content: msg.content }));
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
              details: inputDetails,
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
    return await this.storeChunk(msg, msg.content, "paragraph", 0);
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
    let mergeCount = 0;
    let mergeHistory = "[]";

    // Fast path: exact content_hash match within same owner (agent dimension)
    // Strategy: retire the OLD chunk, keep the NEW one active (latest wins)
    const chunkOwner = msg.owner ?? "agent:main";
    const existingByHash = this.store.findActiveChunkByHash(content, chunkOwner);
    if (existingByHash) {
      this.ctx.log.debug(`Exact-dup (owner=${chunkOwner}): hash match → retiring old=${existingByHash}, keeping new=${chunkId}`);
      this.store.recordMergeHit(existingByHash, "DUPLICATE", "exact content hash match");
      const oldChunk = this.store.getChunk(existingByHash);
      this.store.markDedupStatus(existingByHash, "duplicate", chunkId, "exact content hash match");
      this.store.deleteEmbedding(existingByHash);
      mergedFromOld = existingByHash;
      dedupReason = "exact content hash match";
      if (oldChunk) {
        const oldHistory = JSON.parse(oldChunk.mergeHistory || "[]");
        oldHistory.push({ action: "duplicate_superseded", at: Date.now(), reason: "exact content hash match", sourceChunkId: existingByHash });
        mergeHistory = JSON.stringify(oldHistory);
        mergeCount = (oldChunk.mergeCount || 0) + 1;
      }
    }

    // Smart dedup: find Top-5 similar chunks, then ask LLM to judge
    if (dedupStatus === "active" && embedding) {
      const similarThreshold = this.ctx.config.dedup?.similarityThreshold ?? 0.80;
      const dedupOwnerFilter = msg.owner ? [msg.owner] : undefined;
      const topSimilar = findTopSimilar(this.store, embedding, similarThreshold, 5, this.ctx.log, dedupOwnerFilter);

      if (topSimilar.length > 0) {
        const candidates = topSimilar.map((s, i) => {
          const chunk = this.store.getChunk(s.chunkId);
          return {
            index: i + 1,
            summary: chunk?.summary ?? "",
            chunkId: s.chunkId,
            role: chunk?.role,
          };
        }).filter(c => c.summary && c.role === msg.role);

        if (candidates.length > 0) {
          const dedupResult = await this.summarizer.judgeDedup(summary, candidates);

          if (dedupResult && dedupResult.action === "DUPLICATE" && dedupResult.targetIndex) {
            const targetChunkId = candidates[dedupResult.targetIndex - 1]?.chunkId;
            if (targetChunkId) {
              this.store.recordMergeHit(targetChunkId, "DUPLICATE", dedupResult.reason);
              const oldChunk = this.store.getChunk(targetChunkId);
              this.store.markDedupStatus(targetChunkId, "duplicate", chunkId, dedupResult.reason);
              this.store.deleteEmbedding(targetChunkId);
              mergedFromOld = targetChunkId;
              dedupReason = dedupResult.reason;
              if (oldChunk) {
                const oldHistory = JSON.parse(oldChunk.mergeHistory || "[]");
                oldHistory.push({ action: "duplicate_superseded", at: Date.now(), reason: dedupResult.reason, sourceChunkId: targetChunkId });
                mergeHistory = JSON.stringify(oldHistory);
                mergeCount = (oldChunk.mergeCount || 0) + 1;
              }
              this.ctx.log.debug(`Smart dedup: DUPLICATE → retiring old=${targetChunkId}, keeping new=${chunkId} active, reason: ${dedupResult.reason}`);
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

              // Inherit merge history from the old chunk
              if (oldChunk) {
                const oldHistory = JSON.parse(oldChunk.mergeHistory || "[]");
                oldHistory.push({
                  action: "merge",
                  at: Date.now(),
                  reason: dedupResult.reason,
                  from: oldSummary,
                  to: dedupResult.mergedSummary,
                  sourceChunkId: targetChunkId,
                });
                mergeHistory = JSON.stringify(oldHistory);
                mergeCount = (oldChunk.mergeCount || 0) + 1;
              }

              this.ctx.log.debug(`Smart dedup: UPDATE → old chunk=${targetChunkId} retired, new chunk=${chunkId} gets merged summary (mergeCount=${mergeCount}), reason: ${dedupResult.reason}`);
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
      mergeCount: mergeCount,
      lastHitAt: null,
      mergeHistory: mergeHistory,
      createdAt: msg.timestamp,
      updatedAt: msg.timestamp,
    };

    this.store.insertChunk(chunk);
    if (embedding && dedupStatus === "active") {
      this.store.upsertEmbedding(chunkId, embedding);
    }
    this.ctx.log.debug(`Stored chunk=${chunkId} kind=${kind} role=${msg.role} dedup=${dedupStatus} len=${content.length} hasVec=${!!embedding && dedupStatus === "active"}`);

    if (mergedFromOld) {
      return { action: "merged", chunkId, summary, targetChunkId: mergedFromOld, reason: dedupReason ?? undefined };
    }
    return { action: "stored", chunkId, summary };
  }
}
