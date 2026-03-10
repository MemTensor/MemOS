import { v4 as uuid } from "uuid";
import type { SqliteStore } from "../storage/sqlite";
import type { PluginContext, Task, Chunk } from "../types";
import { DEFAULTS } from "../types";
import { Summarizer } from "./providers";

const TRIVIAL_PATTERNS = [
  /^(test|testing|hello|hi|hey|ok|okay|yes|no|yeah|nope|sure|thanks|thank you|thx|ping|pong|哈哈|好的|嗯|是的|不是|谢谢|你好|测试)\s*[.!?。！？]*$/,
  /^(aaa+|bbb+|xxx+|zzz+|123+|asdf+|qwer+|haha+|lol+|hmm+)\s*$/,
  /^[\s\p{P}\p{S}]*$/u,
];

const SKIP_REASONS = {
  noChunks: "该任务没有对话内容，已自动跳过。",
} as const;

/**
 * Asynchronous task-level processor.
 *
 * After each ingestion batch, checks whether the current conversation
 * constitutes a "new task" compared to the previous one. If so:
 *   1. Finalizes the previous task (generates a detailed summary).
 *   2. Creates a new active task for incoming chunks.
 *
 * Task boundary detection:
 *   - Session change → always new task
 *   - Time gap > 2h → always new task
 *   - LLM judges whether new user message starts a different topic
 */
export class TaskProcessor {
  private summarizer: Summarizer;
  private processing = false;
  private pendingEvents: Array<{ sessionKey: string; latestTimestamp: number; owner: string }> = [];
  private drainPromise: Promise<void> | null = null;
  private onTaskCompletedCallback?: (task: Task) => void;

  constructor(
    private store: SqliteStore,
    private ctx: PluginContext,
  ) {
    const strongCfg = ctx.config.skillEvolution?.summarizer;
    this.summarizer = new Summarizer(ctx.config.summarizer, ctx.log, strongCfg);
  }

  onTaskCompleted(cb: (task: Task) => void): void {
    this.onTaskCompletedCallback = cb;
  }

  /**
   * Called after new chunks are ingested.
   * Determines if a new task boundary was crossed and handles transition.
   */
  async onChunksIngested(sessionKey: string, latestTimestamp: number, owner?: string): Promise<void> {
    const resolvedOwner = owner ?? "agent:main";
    this.ctx.log.debug(`TaskProcessor.onChunksIngested called session=${sessionKey} ts=${latestTimestamp} owner=${resolvedOwner} processing=${this.processing}`);
    this.pendingEvents.push({ sessionKey, latestTimestamp, owner: resolvedOwner });

    if (!this.drainPromise) {
      this.drainPromise = this.drainPending();
    }

    await this.drainPromise;
  }

  private async drainPending(): Promise<void> {
    this.processing = true;
    try {
      while (this.pendingEvents.length > 0) {
        const next = this.pendingEvents.shift()!;
        try {
          await this.detectAndProcess(next.sessionKey, next.latestTimestamp, next.owner);
        } catch (err) {
          this.ctx.log.error(`TaskProcessor error: ${err}`);
        }
      }
    } finally {
      this.processing = false;
      this.drainPromise = null;
    }
  }

  private async detectAndProcess(sessionKey: string, latestTimestamp: number, owner: string): Promise<void> {
    this.ctx.log.debug(`TaskProcessor.detectAndProcess session=${sessionKey} owner=${owner}`);

    const allActive = this.store.getAllActiveTasks(owner);
    for (const t of allActive) {
      if (t.sessionKey !== sessionKey) {
        this.ctx.log.info(`Session changed: finalizing task=${t.id} from session=${t.sessionKey} (owner=${owner})`);
        await this.finalizeTask(t);
      }
    }

    let activeTask = this.store.getActiveTask(sessionKey, owner);
    this.ctx.log.debug(`TaskProcessor.detectAndProcess activeTask=${activeTask?.id ?? "none"} owner=${owner}`);

    if (!activeTask) {
      // Create a new empty task — do NOT assign all chunks yet.
      // processChunksIncrementally will assign them one turn at a time with boundary checks.
      activeTask = await this.createNewTaskReturn(sessionKey, latestTimestamp, owner);
    }

    await this.processChunksIncrementally(activeTask, sessionKey, latestTimestamp, owner);
  }

  /**
   * Process unassigned chunks one user-turn at a time.
   *
   * Strategy:
   * - Need at least 1 user turn in the current task before starting LLM judgment
   *   (0 turns = no reference point for comparison).
   * - Each subsequent user turn is individually checked against the full task context.
   * - Time gap > 2h always triggers a split regardless of topic.
   */
  private async processChunksIncrementally(
    activeTask: Task,
    sessionKey: string,
    latestTimestamp: number,
    owner: string,
  ): Promise<void> {
    const unassigned = this.store.getUnassignedChunks(sessionKey);
    if (unassigned.length === 0) return;

    const taskChunks = this.store.getChunksByTask(activeTask.id);

    // Time gap check against the earliest unassigned chunk
    if (taskChunks.length > 0) {
      const lastTaskTs = Math.max(...taskChunks.map((c) => c.createdAt));
      const firstUnassignedTs = Math.min(...unassigned.map((c) => c.createdAt));
      const gap = firstUnassignedTs - lastTaskTs;
      if (gap > DEFAULTS.taskIdleTimeoutMs) {
        this.ctx.log.info(
          `Task boundary: time gap ${Math.round(gap / 60000)}min > ${Math.round(DEFAULTS.taskIdleTimeoutMs / 60000)}min`,
        );
        await this.finalizeTask(activeTask);
        const newTask = await this.createNewTaskReturn(sessionKey, latestTimestamp, owner);
        // Recurse with the new empty task so remaining unassigned chunks get boundary-checked too
        return this.processChunksIncrementally(newTask, sessionKey, latestTimestamp, owner);
      }
    }

    const turns = this.groupIntoTurns(unassigned);
    if (turns.length === 0) {
      this.assignChunksToTask(unassigned, activeTask.id);
      return;
    }

    let currentTask = activeTask;
    let currentTaskChunks = [...taskChunks];

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const userChunk = turn.find((c) => c.role === "user");

      if (!userChunk) {
        this.assignChunksToTask(turn, currentTask.id);
        currentTaskChunks = currentTaskChunks.concat(turn);
        continue;
      }

      // Time gap check per turn
      if (currentTaskChunks.length > 0) {
        const lastTs = Math.max(...currentTaskChunks.map((c) => c.createdAt));
        if (userChunk.createdAt - lastTs > DEFAULTS.taskIdleTimeoutMs) {
          this.ctx.log.info(`Task boundary at turn ${i}: time gap ${Math.round((userChunk.createdAt - lastTs) / 60000)}min`);
          await this.finalizeTask(currentTask);
          currentTask = await this.createNewTaskReturn(sessionKey, userChunk.createdAt, owner);
          currentTaskChunks = [];
          this.assignChunksToTask(turn, currentTask.id);
          currentTaskChunks = currentTaskChunks.concat(turn);
          continue;
        }
      }

      // Need at least 1 user turn before we can meaningfully judge topic shifts
      const existingUserCount = currentTaskChunks.filter((c) => c.role === "user").length;
      if (existingUserCount < 1) {
        this.assignChunksToTask(turn, currentTask.id);
        currentTaskChunks = currentTaskChunks.concat(turn);
        continue;
      }

      // LLM topic judgment — check this single user message against full task context
      const context = this.buildContextSummary(currentTaskChunks);
      const newMsg = userChunk.content.slice(0, 500);
      this.ctx.log.info(`Topic judge: "${newMsg.slice(0, 60)}" vs ${existingUserCount} user turns`);
      const isNew = await this.summarizer.judgeNewTopic(context, newMsg);
      this.ctx.log.info(`Topic judge result: ${isNew === null ? "null(fallback)" : isNew ? "NEW" : "SAME"}`);

      if (isNew === null) {
        this.assignChunksToTask(turn, currentTask.id);
        currentTaskChunks = currentTaskChunks.concat(turn);
        continue;
      }

      if (isNew) {
        this.ctx.log.info(`Task boundary at turn ${i}: LLM judged new topic. Msg: "${newMsg.slice(0, 80)}..."`);
        await this.finalizeTask(currentTask);
        currentTask = await this.createNewTaskReturn(sessionKey, userChunk.createdAt, owner);
        currentTaskChunks = [];
      }

      this.assignChunksToTask(turn, currentTask.id);
      currentTaskChunks = currentTaskChunks.concat(turn);
    }

    this.store.updateTask(currentTask.id, { endedAt: undefined });
  }

  /**
   * Group chunks into user-turns: each turn starts with a user message
   * and includes all subsequent non-user messages until the next user message.
   */
  private groupIntoTurns(chunks: Chunk[]): Chunk[][] {
    const turns: Chunk[][] = [];
    let current: Chunk[] = [];

    for (const c of chunks) {
      if (c.role === "user" && current.length > 0) {
        turns.push(current);
        current = [];
      }
      current.push(c);
    }
    if (current.length > 0) turns.push(current);
    return turns;
  }

  /**
   * Build context from existing task chunks for the LLM topic judge.
   * Includes both the task's opening topic and recent exchanges,
   * so the LLM understands both what the task was originally about
   * and where the conversation currently is.
   *
   * For user messages, include full content (up to 500 chars) since
   * they carry the topic signal. For assistant messages, use summary
   * or truncated content since they mostly elaborate.
   */
  private buildContextSummary(chunks: Chunk[]): string {
    const conversational = chunks.filter((c) => c.role === "user" || c.role === "assistant");
    if (conversational.length === 0) return "";

    const formatChunk = (c: Chunk) => {
      const label = c.role === "user" ? "User" : "Assistant";
      const maxLen = c.role === "user" ? 500 : 200;
      const text = c.summary || c.content.slice(0, maxLen);
      return `[${label}]: ${text}`;
    };

    if (conversational.length <= 10) {
      return conversational.map(formatChunk).join("\n");
    }

    const opening = conversational.slice(0, 6).map(formatChunk);
    const recent = conversational.slice(-4).map(formatChunk);
    return [
      "--- Task opening ---",
      ...opening,
      "--- Recent exchanges ---",
      ...recent,
    ].join("\n");
  }

  private async createNewTaskReturn(sessionKey: string, timestamp: number, owner: string = "agent:main"): Promise<Task> {
    const taskId = uuid();
    const task: Task = {
      id: taskId,
      sessionKey,
      title: "",
      summary: "",
      status: "active",
      owner,
      startedAt: timestamp,
      endedAt: null,
      updatedAt: timestamp,
    };
    this.store.insertTask(task);
    this.ctx.log.info(`Created new task=${taskId} session=${sessionKey}`);
    return task;
  }

  private async createNewTask(sessionKey: string, timestamp: number, owner: string = "agent:main"): Promise<void> {
    const task = await this.createNewTaskReturn(sessionKey, timestamp, owner);
    this.assignUnassignedChunks(sessionKey, task.id);
  }

  private assignChunksToTask(chunks: Chunk[], taskId: string): void {
    for (const chunk of chunks) {
      this.store.setChunkTaskId(chunk.id, taskId);
    }
    if (chunks.length > 0) {
      this.ctx.log.debug(`Assigned ${chunks.length} chunks to task=${taskId}`);
    }
  }

  private assignUnassignedChunks(sessionKey: string, taskId: string): void {
    const unassigned = this.store.getUnassignedChunks(sessionKey);
    this.assignChunksToTask(unassigned, taskId);
  }

  async finalizeTask(task: Task): Promise<void> {
    const chunks = this.store.getChunksByTask(task.id);
    const fallbackTitle = chunks.length > 0 ? this.extractTitle(chunks) : "";

    if (chunks.length === 0) {
      this.ctx.log.info(`Task ${task.id} skipped: no chunks`);
      this.store.updateTask(task.id, { title: fallbackTitle, summary: SKIP_REASONS.noChunks, status: "skipped", endedAt: Date.now() });
      return;
    }

    const skipReason = this.shouldSkipSummary(chunks);

    if (skipReason) {
      this.ctx.log.info(`Task ${task.id} skipped: ${skipReason} (chunks=${chunks.length}, title="${fallbackTitle}")`);
      const reason = this.humanReadableSkipReason(skipReason, chunks);
      this.store.updateTask(task.id, { title: fallbackTitle, summary: reason, status: "skipped", endedAt: Date.now() });
      return;
    }

    const conversationText = this.buildConversationText(chunks);
    let summary: string;
    try {
      summary = await this.summarizer.summarizeTask(conversationText);
    } catch (err) {
      this.ctx.log.warn(`Task summary generation failed for task=${task.id}: ${err}`);
      summary = this.fallbackSummary(chunks);
    }

    const { title: llmTitle, body } = this.parseTitleFromSummary(summary);
    const title = llmTitle || fallbackTitle;

    this.store.updateTask(task.id, {
      title,
      summary: body,
      status: "completed",
      endedAt: Date.now(),
    });

    this.ctx.log.info(
      `Finalized task=${task.id} title="${title}" chunks=${chunks.length} summaryLen=${body.length}`,
    );

    if (this.onTaskCompletedCallback) {
      const finalized = this.store.getTask(task.id);
      if (finalized) {
        try {
          this.onTaskCompletedCallback(finalized);
        } catch (err) {
          this.ctx.log.warn(`TaskProcessor onTaskCompleted callback error: ${err}`);
        }
      }
    }
  }

  /**
   * Determine if a task is too trivial to warrant an LLM summary call.
   * Returns a skip reason string, or null if summary should proceed.
   *
   * Skip conditions (any one triggers skip):
   *  1. Total chunks < 4 — too few messages to form a meaningful task
   *  2. Real conversation turns < 2 — no back-and-forth dialogue
   *  3. No user messages — purely system/tool generated, no user intent
   *  4. Total content < 200 chars — not enough substance
   *  5. User content is trivial/test data — "hello", "test", "ok" etc.
   *  6. All messages are tool results — automated output, no conversation
   *  7. High content repetition — user repeated the same thing (debug loops)
   */
  private shouldSkipSummary(chunks: Chunk[]): string | null {
    const userChunks = chunks.filter((c) => c.role === "user");
    const assistantChunks = chunks.filter((c) => c.role === "assistant");
    const toolChunks = chunks.filter((c) => c.role === "tool");

    // 1. Too few chunks
    if (chunks.length < 4) {
      return `too few chunks (${chunks.length} < 4 minimum)`;
    }

    // 2. Not enough real conversation turns (need at least 2 user-assistant exchanges)
    const turns = Math.min(userChunks.length, assistantChunks.length);
    if (turns < 2) {
      return `too few conversation turns (${turns} < 2 minimum)`;
    }

    // 3. No user messages at all — purely automated
    if (userChunks.length === 0) {
      return "no user messages — task appears to be automated/system-generated";
    }

    // 4. Total content too short
    // CJK characters carry more info per char, so use a lower threshold
    const totalContentLen = chunks.reduce((sum, c) => sum + c.content.length, 0);
    const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(
      userChunks[0]?.content ?? "",
    );
    const minContentLen = hasCJK ? 80 : 200;
    if (totalContentLen < minContentLen) {
      return `content too short (${totalContentLen} chars < ${minContentLen} minimum)`;
    }

    // 5. User content is trivial/test data
    const userContent = userChunks.map((c) => c.content).join("\n");
    if (this.looksLikeTrivialContent(userContent)) {
      return "user content appears to be test/trivial data";
    }

    // 6. Assistant content is also trivial (both sides are low-value)
    const assistantContent = assistantChunks.map((c) => c.content).join("\n");
    if (this.looksLikeTrivialContent(userContent + "\n" + assistantContent)) {
      return "conversation content (both user and assistant) appears trivial";
    }

    // 7. Almost all messages are tool results with minimal user interaction
    if (toolChunks.length > 0 && toolChunks.length >= chunks.length * 0.7 && userChunks.length <= 1) {
      return `dominated by tool results (${toolChunks.length}/${chunks.length} chunks) with minimal user input`;
    }

    // 8. High repetition — user keeps saying the same thing
    if (userChunks.length >= 3) {
      const uniqueUserMsgs = new Set(userChunks.map((c) => c.content.trim().toLowerCase()));
      const uniqueRatio = uniqueUserMsgs.size / userChunks.length;
      if (uniqueRatio < 0.4) {
        return `high content repetition (${uniqueUserMsgs.size} unique out of ${userChunks.length} user messages)`;
      }
    }

    return null;
  }

  private looksLikeTrivialContent(text: string): boolean {
    const lines = text.toLowerCase().split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return true;

    const trivialCount = lines.filter((line) => {
      if (line.length < 5) return true;
      if (TRIVIAL_PATTERNS.some((p) => p.test(line))) return true;
      return false;
    }).length;

    return trivialCount / lines.length > 0.7;
  }

  private buildConversationText(chunks: Chunk[]): string {
    const lines: string[] = [];
    for (const c of chunks) {
      const roleLabel = c.role === "user" ? "User" : c.role === "assistant" ? "Assistant" : c.role;
      lines.push(`[${roleLabel}]: ${c.content}`);
    }
    return lines.join("\n\n");
  }

  /**
   * Extract the LLM-generated title from the summary output.
   * The LLM is prompted to output "📌 Title\n<title text>" as the first section.
   * Returns the title and the remaining body (with the title section stripped).
   */
  private parseTitleFromSummary(summary: string): { title: string; body: string } {
    const titleMatch = summary.match(/📌\s*(?:Title|标题)\s*\n(.+)/);
    if (titleMatch) {
      const title = titleMatch[1].trim().slice(0, 80);
      const body = summary.replace(/📌\s*(?:Title|标题)\s*\n.+\n?/, "").trim();
      return { title, body };
    }
    return { title: "", body: summary };
  }

  private extractTitle(chunks: Chunk[]): string {
    const firstUser = chunks.find((c) => c.role === "user");
    if (!firstUser) return "Untitled Task";
    const text = firstUser.content.trim();
    if (text.length <= 60) return text;
    return text.slice(0, 57) + "...";
  }

  private humanReadableSkipReason(reason: string, chunks: Chunk[]): string {
    const userCount = chunks.filter((c) => c.role === "user").length;
    const assistantCount = chunks.filter((c) => c.role === "assistant").length;

    if (reason.includes("too few chunks")) {
      return `对话内容过少（${chunks.length} 条消息），不足以生成有效摘要。至少需要 4 条消息。`;
    }
    if (reason.includes("too few conversation turns")) {
      return `对话轮次不足（${Math.min(userCount, assistantCount)} 轮），需要至少 2 轮完整的问答交互才能生成摘要。`;
    }
    if (reason.includes("no user messages")) {
      return "该任务没有用户消息，仅包含系统或工具自动生成的内容。";
    }
    if (reason.includes("content too short")) {
      return "对话内容过短，信息量不足以生成有意义的摘要。";
    }
    if (reason.includes("trivial")) {
      return "对话内容为简单问候或测试数据（如 hello、test、ok），无需生成摘要。";
    }
    if (reason.includes("tool results")) {
      return "该任务主要由工具执行结果组成，缺少足够的用户交互内容。";
    }
    if (reason.includes("repetition")) {
      return "对话中存在大量重复内容，无法提取有效信息生成摘要。";
    }
    return `对话未达到生成摘要的条件：${reason}`;
  }

  private fallbackSummary(chunks: Chunk[]): string {
    const title = this.extractTitle(chunks);
    const summaries = chunks
      .filter((c) => c.summary)
      .map((c) => `- ${c.summary}`);
    const lines = [
      `🎯 Goal`,
      title,
      ``,
      `📋 Key Steps`,
      ...summaries.slice(0, 20),
    ];
    return lines.join("\n");
  }
}
