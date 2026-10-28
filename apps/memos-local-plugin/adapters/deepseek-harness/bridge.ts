/**
 * DeepSeek Harness lifecycle bridge.
 *
 * The bridge intentionally depends only on MemOS's stable agent contract and
 * structural host shapes. The Cordis-facing entrypoint owns imports from DSH;
 * keeping them out of this file makes the lifecycle logic independently
 * testable and prevents DSH types from leaking into the algorithm core.
 */

import type {
  EpisodeId,
  RuntimeNamespace,
  SessionId,
  ToolCallDTO,
} from "../../agent-contract/dto.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";
import type { DeepSeekHarnessLlmRoute } from "./host-llm.js";
import { waitForDeepSeekHarnessDeadline } from "./deadline.js";

export const DEEPSEEK_HARNESS_AGENT = "deepseek-harness";
export const DEEPSEEK_HARNESS_PLUGIN = "memos-local-memory";

export interface DshContentBlockLike {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface DshUserMessageLike {
  readonly id: string;
  readonly role: "user";
  readonly content: readonly DshContentBlockLike[];
  readonly source: {
    readonly kind: string;
    readonly [key: string]: unknown;
  };
}

export interface DshSessionLike {
  readonly id: string;
  /** Canonical history is available on real DSH Session instances. */
  readonly events?: readonly DshSessionEventLike[];
  readonly header?: {
    readonly cwd?: string;
    /** Events below this boundary were inherited from a fork parent. */
    readonly seedLength?: number;
    readonly [key: string]: unknown;
  };
  readonly requestHeader?: () => {
    readonly config?: {
      readonly provider?: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  } | undefined;
}

export interface DshAgentLike {
  readonly id: string;
  readonly session: DshSessionLike;
  readonly options?: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly [key: string]: unknown;
  };
}

export type DshPreStepDecisionLike =
  | { readonly kind: "reject" }
  | { readonly kind: "enter"; readonly messages: DshUserMessageLike[] };

export interface DshPreStepPayloadLike {
  readonly agent: DshAgentLike;
  readonly messages: DshUserMessageLike[];
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface DshSessionEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly surfaceOp?: "append" | {
    readonly op: "replace";
    readonly start: number;
    readonly end: number;
  };
}

export interface DeepSeekHarnessBridgeOptions {
  core: MemoryCore;
  profileId: string;
  recallEnabled: boolean;
  captureEnabled: boolean;
  recallTimeoutMs: number;
  contextMaxChars: number;
  createRecallMessage: (text: string) => DshUserMessageLike;
  runWithLlmRoute?: <T>(
    route: DeepSeekHarnessLlmRoute,
    operation: () => T,
  ) => T;
  now?: () => number;
  onWarn?: (message: string, error?: unknown) => void;
  onInfo?: (message: string) => void;
}

interface MutableToolCall extends ToolCallDTO {
  callId: string;
}

interface TurnState {
  dshSession: DshSessionLike;
  dshSessionId: string;
  turn: number;
  startedAt: number;
  endedAt?: number;
  namespace: RuntimeNamespace;
  cwd?: string;
  userText: string;
  durableUserMessageIds: Set<string>;
  durableUserTexts: string[];
  memorySessionId: SessionId;
  episodeId?: EpisodeId;
  assistantText: string[];
  assistantThinking: string[];
  toolCalls: MutableToolCall[];
  promptResolved: boolean;
  recallAttempted: boolean;
  captureQueued: boolean;
  llmRoute?: DeepSeekHarnessLlmRoute;
  turnEndReason?: unknown;
}

interface ToolResultSummary {
  output: unknown;
  failed: boolean;
}

/**
 * Owns per-session turn correlation and a serial write queue.
 *
 * DSH's `session/event` hook is a synchronous firehose. The bridge therefore
 * records events synchronously and queues lifecycle writes. Retrieval is the
 * only foreground memory operation in `beforeStep()` because its returned
 * context must enter that exact model request. Relation/intent routing and
 * capture stay in the serial background queue; only disposal drains it.
 */
export class DeepSeekHarnessBridge {
  private readonly core: MemoryCore;
  private readonly profileId: string;
  private readonly recallEnabled: boolean;
  private readonly captureEnabled: boolean;
  private readonly recallTimeoutMs: number;
  private readonly contextMaxChars: number;
  private readonly createRecallMessage: (text: string) => DshUserMessageLike;
  private readonly runWithLlmRoute?: DeepSeekHarnessBridgeOptions["runWithLlmRoute"];
  private readonly now: () => number;
  private readonly onWarn: (message: string, error?: unknown) => void;
  private readonly onInfo: (message: string) => void;

  private readonly turns = new Map<DshSessionLike, Map<number, TurnState>>();
  private readonly activeTurnBySession = new Map<DshSessionLike, number>();
  private readonly pendingBySession = new Map<string, Promise<void>>();
  private readonly lastLlmRouteBySession = new Map<
    DshSessionLike,
    DeepSeekHarnessLlmRoute
  >();
  private readonly memorySessionOwners = new Map<SessionId, Set<DshSessionLike>>();
  private readonly memorySessionsByDsh = new Map<DshSessionLike, Set<SessionId>>();
  private readonly knownDshSessions = new Set<DshSessionLike>();
  private readonly closingBySession = new Map<DshSessionLike, Promise<void>>();
  private readonly closingMemorySessions = new Map<SessionId, Promise<void>>();
  private disposePromise: Promise<void> | null = null;

  constructor(options: DeepSeekHarnessBridgeOptions) {
    this.core = options.core;
    this.profileId = options.profileId;
    this.recallEnabled = options.recallEnabled;
    this.captureEnabled = options.captureEnabled;
    this.recallTimeoutMs = options.recallTimeoutMs;
    this.contextMaxChars = options.contextMaxChars;
    this.createRecallMessage = options.createRecallMessage;
    this.runWithLlmRoute = options.runWithLlmRoute;
    this.now = options.now ?? (() => Date.now());
    this.onWarn = options.onWarn ?? (() => undefined);
    this.onInfo = options.onInfo ?? (() => undefined);
  }

  async beforeStep(
    payload: DshPreStepPayloadLike,
    next: () => Promise<DshPreStepDecisionLike>,
  ): Promise<DshPreStepDecisionLike> {
    const decision = await next();
    if (payload.step !== 1) return decision;

    const session = payload.agent.session;
    const state = this.ensureTurn(session, payload.turn);
    const preStepRoute = extractDeepSeekHarnessLlmRoute(payload.agent);
    if (preStepRoute) this.rememberLlmRoute(state, preStepRoute);

    // `next()` is the authoritative waterfall decision. A downstream policy
    // may redact, rewrite, or remove claimed input; never recall from or
    // persist the pre-policy payload in that case.
    const userText = decision.kind === "enter"
      ? userTextFromMessages(decision.messages)
      : "";
    state.userText = userText;
    state.promptResolved = true;
    if (decision.kind === "reject" || !this.recallEnabled || !userText) {
      return decision;
    }
    if (state.recallAttempted) return decision;

    try {
      if (payload.signal.aborted) return decision;
      // Each accepted direct-user turn receives one bounded recall. Repeated
      // pre-step callbacks for the same turn are de-duplicated by TurnState.
      state.recallAttempted = true;

      const startedAt = this.now();
      const deadlineAt = startedAt + this.recallTimeoutMs;
      const recall = this.withLlmRoute(
        state,
        async () => this.core.searchMemory({
          agent: DEEPSEEK_HARNESS_AGENT,
          namespace: state.namespace,
          sessionId: session.id,
          query: userText,
          reason: "turn_start",
          contextHints: {
            dshTurn: payload.turn,
            dshStep: payload.step,
            cwd: state.cwd,
          },
          deadlineAt,
          llmFilterMalformedRetries: 0,
        }, { signal: payload.signal }),
      );
      // The core receives the same absolute deadline, but a provider can be
      // temporarily non-cancellable (for example while a local ONNX model is
      // loading). Keep the host-facing contract hard: an optional recall may
      // never hold DSH's prompt path beyond the configured budget. The losing
      // promise remains observed by Promise.race and finishes fail-open in the
      // core once its own deadline propagates.
      const packet = await waitForDeepSeekHarnessDeadline(
        Promise.resolve(recall),
        {
          deadlineAt,
          signal: payload.signal,
          now: this.now,
          timeoutMessage: `MemOS recall exceeded ${this.recallTimeoutMs}ms`,
        },
      );

      const context = renderRecallContext(packet.injectedContext, this.contextMaxChars);
      this.onInfo(
        `recall session=${session.id} turn=${payload.turn} hits=${packet.hits.length} chars=${context.length}`,
      );
      if (payload.signal.aborted) {
        return decision;
      }
      if (!context) return decision;

      return {
        kind: "enter",
        // Match DSH's native context ordering: accepted user input is recorded
        // first, then source-labelled context. This keeps the conversation UI
        // chronological while preserving the context in the same model step.
        messages: [...decision.messages, this.createRecallMessage(context)],
      };
    } catch (error) {
      // Memory is an optional enhancement. A retrieval/configuration failure
      // must not block the host agent's step.
      this.warn(
        `DeepSeek Harness recall failed for session ${session.id}, turn ${payload.turn}`,
        error,
      );
      return decision;
    }
  }

  onSessionEvent(session: DshSessionLike, event: DshSessionEventLike): void {
    this.knownDshSessions.add(session);
    switch (event.type) {
      case "turn/start": {
        const turn = readNumber(event.data, "turn");
        if (turn === undefined) return;
        this.ensureTurn(session, turn).startedAt = event.time;
        this.activeTurnBySession.set(session, turn);
        return;
      }
      case "user/message": {
        const turn = this.activeTurnBySession.get(session);
        if (!isUserMessage(event.data)) return;
        if (event.data.source.kind !== "user") return;
        if (turn === undefined) return;
        const state = this.getTurn(session, turn);
        if (!state) return;
        const text = textFromContent(event.data.content, "text");
        if (text && !state.durableUserMessageIds.has(event.data.id)) {
          state.durableUserMessageIds.add(event.data.id);
          state.durableUserTexts.push(text);
          if (!state.promptResolved) {
            state.userText = state.durableUserTexts.join("\n\n");
          }
        }
        return;
      }
      case "assistant/message": {
        const data = asRecord(event.data);
        const turn = readNumber(data, "turn");
        const message = asRecord(data?.["message"]);
        if (turn === undefined || !message) return;
        const state = this.getTurn(session, turn);
        const content = message["content"];
        if (!state || !Array.isArray(content)) return;
        pushUnique(state.assistantText, textFromContent(content, "text"));
        pushUnique(state.assistantThinking, textFromContent(content, "reasoning"));
        return;
      }
      case "tool/call": {
        const data = asRecord(event.data);
        const turn = readNumber(data, "turn");
        const callId = readString(data, "callId");
        const name = readString(data, "name");
        if (turn === undefined || !callId || !name) return;
        const state = this.getTurn(session, turn);
        if (!state || state.toolCalls.some((tool) => tool.callId === callId)) return;
        state.toolCalls.push({
          callId,
          toolCallId: callId,
          name,
          input: parseToolArguments(data?.["arguments"]),
          startedAt: event.time,
        });
        return;
      }
      case "tool/result": {
        this.handleToolResult(session, event);
        return;
      }
      case "tool/code-dispatch-start": {
        this.handleCodeDispatchStart(session, event);
        return;
      }
      case "tool/code-dispatch": {
        this.handleCodeDispatchResult(session, event);
        return;
      }
      case "turn/end": {
        const data = asRecord(event.data);
        const turn = readNumber(data, "turn");
        if (turn === undefined) return;
        const state = this.getTurn(session, turn);
        if (!state || state.captureQueued) return;
        const persistedRoute = extractDeepSeekHarnessLlmRoute({
          id: session.id,
          session,
        });
        if (persistedRoute) this.rememberLlmRoute(state, persistedRoute);
        state.endedAt = event.time;
        state.turnEndReason = data?.["reason"];
        state.captureQueued = true;
        if (this.activeTurnBySession.get(session) === turn) {
          this.activeTurnBySession.delete(session);
        }
        if (!this.captureEnabled || !state.userText) {
          this.deleteTurn(session, turn);
          return;
        }
        this.enqueue(session.id, async () => this.captureTurn(state));
        return;
      }
      default:
        return;
    }
  }

  currentEpisode(session: DshSessionLike): EpisodeId | undefined {
    const turn = this.activeTurnBySession.get(session);
    return turn === undefined ? undefined : this.getTurn(session, turn)?.episodeId;
  }

  namespaceFor(session: DshSessionLike): RuntimeNamespace {
    const preset = session.header?.["agentPreset"];
    const profileId = typeof preset === "string" && preset.trim()
      ? preset.trim()
      : this.profileId;
    return {
      agentKind: DEEPSEEK_HARNESS_AGENT,
      profileId,
      profileLabel: profileId,
      workspacePath: session.header?.cwd,
      sessionKey: session.id,
    };
  }

  async flush(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      // A job can enqueue a successor while the current promise settles, so
      // re-read until the queue is genuinely empty.
      while (true) {
        const pending = this.pendingBySession.get(sessionId);
        if (!pending) return;
        await pending;
        if (this.pendingBySession.get(sessionId) === pending) return;
      }
    }
    while (this.pendingBySession.size > 0) {
      await Promise.all([...this.pendingBySession.values()]);
    }
  }

  async closeSession(session: DshSessionLike): Promise<void> {
    const existing = this.closingBySession.get(session);
    if (existing) return existing;

    const closing = (async () => {
      await this.flush(session.id);
      const memorySessionIds = this.memorySessionIdsFor(session);
      for (const memorySessionId of memorySessionIds) {
        await this.releaseMemorySession(session, memorySessionId);
      }
      this.turns.delete(session);
      this.activeTurnBySession.delete(session);
      this.knownDshSessions.delete(session);
      this.memorySessionsByDsh.delete(session);
      this.lastLlmRouteBySession.delete(session);
    })();
    this.closingBySession.set(session, closing);
    try {
      await closing;
    } finally {
      if (this.closingBySession.get(session) === closing) {
        this.closingBySession.delete(session);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      await this.flush();
      await Promise.all([...this.knownDshSessions].map((session) => this.closeSession(session)));
      await this.flush();

      // Defensive orphan cleanup before the global pipeline drain.
      for (const sessionId of [...this.memorySessionOwners.keys()]) {
        const owner = this.memorySessionOwners.get(sessionId)?.values().next().value;
        try {
          await this.withSessionLlmRoute(
            owner,
            () => this.core.closeSession(sessionId),
          );
        } catch (error) {
          this.warn(`MemOS closeSession failed for ${sessionId}`, error);
        } finally {
          this.memorySessionOwners.delete(sessionId);
        }
      }
      await Promise.allSettled([...this.closingMemorySessions.values()]);
      await this.core.shutdown();
      this.lastLlmRouteBySession.clear();
    })();
    return this.disposePromise;
  }

  private ensureTurn(session: DshSessionLike, turn: number): TurnState {
    this.knownDshSessions.add(session);
    let sessionTurns = this.turns.get(session);
    if (!sessionTurns) {
      sessionTurns = new Map<number, TurnState>();
      this.turns.set(session, sessionTurns);
    }
    const existing = sessionTurns.get(turn);
    if (existing) return existing;
    const state: TurnState = {
      dshSession: session,
      dshSessionId: session.id,
      turn,
      startedAt: this.now(),
      namespace: this.namespaceFor(session),
      cwd: session.header?.cwd,
      userText: "",
      durableUserMessageIds: new Set<string>(),
      durableUserTexts: [],
      memorySessionId: session.id,
      assistantText: [],
      assistantThinking: [],
      toolCalls: [],
      promptResolved: false,
      recallAttempted: false,
      captureQueued: false,
    };
    sessionTurns.set(turn, state);
    return state;
  }

  private getTurn(session: DshSessionLike, turn: number): TurnState | undefined {
    return this.turns.get(session)?.get(turn);
  }

  private deleteTurn(session: DshSessionLike, turn: number): void {
    const sessionTurns = this.turns.get(session);
    if (!sessionTurns) return;
    sessionTurns.delete(turn);
    if (sessionTurns.size === 0) this.turns.delete(session);
  }

  private enqueue(sessionId: string, task: () => Promise<void>): void {
    const previous = this.pendingBySession.get(sessionId) ?? Promise.resolve();
    let settled: Promise<void>;
    const current = previous.then(task).catch((error) => {
      this.warn(`MemOS background write failed for DSH session ${sessionId}`, error);
    });
    settled = current.finally(() => {
      if (this.pendingBySession.get(sessionId) === settled) {
        this.pendingBySession.delete(sessionId);
      }
    });
    this.pendingBySession.set(sessionId, settled);
  }

  private async captureTurn(state: TurnState): Promise<void> {
    try {
      let memorySessionId = state.memorySessionId;
      let episodeId = state.episodeId;

      try {
        const prepareTurn = this.core.prepareTurn;
        if (!prepareTurn) {
          throw new Error("MemoryCore does not expose prepareTurn");
        }
        await this.waitForMemorySessionClose(memorySessionId);
        const prepared = await this.withLlmRoute(
          state,
          async () => prepareTurn.call(this.core, {
            agent: DEEPSEEK_HARNESS_AGENT,
            namespace: state.namespace,
            sessionId: memorySessionId,
            turnKey: `${state.dshSessionId}:${state.turn}`,
            userText: state.userText,
            contextHints: {
              __memosBackgroundLifecycle: true,
              dshTurn: state.turn,
              cwd: state.cwd,
            },
            ts: state.startedAt,
          }),
        );
        memorySessionId = prepared.sessionId;
        episodeId = prepared.episodeId;
        state.memorySessionId = memorySessionId;
        state.episodeId = episodeId;
        this.trackMemorySession(state.dshSession, memorySessionId);
      } catch (error) {
        this.warn(
          `MemOS background turn routing failed for DSH session ${state.dshSessionId}; using a lazy episode`,
          error,
        );
      }

      if (!this.ownsMemorySession(state.dshSession, memorySessionId)) {
        await this.waitForMemorySessionClose(memorySessionId);
        memorySessionId = await this.core.openSession({
          agent: DEEPSEEK_HARNESS_AGENT,
          sessionId: memorySessionId,
          namespace: state.namespace,
          meta: { namespace: state.namespace },
        });
        state.memorySessionId = memorySessionId;
        this.trackMemorySession(state.dshSession, memorySessionId);
      }

      if (!episodeId) {
        episodeId = await this.core.openEpisode({
          sessionId: memorySessionId,
          userMessage: state.userText,
        });
        state.episodeId = episodeId;
      }

      this.recordCompletedToolOutcomes(state, memorySessionId, episodeId);

      const result = await this.withLlmRoute(
        state,
        async () => this.core.onTurnEnd({
          agent: DEEPSEEK_HARNESS_AGENT,
          namespace: state.namespace,
          sessionId: memorySessionId,
          episodeId,
          agentText: state.assistantText.join("\n\n").trim(),
          agentThinking: optionalJoined(state.assistantThinking),
          toolCalls: state.toolCalls.map(({ callId: _callId, ...tool }) => tool),
          contextHints: {
            dshTurn: state.turn,
            cwd: state.cwd,
            turnEndReason: state.turnEndReason,
          },
          ts: state.endedAt ?? this.now(),
        }),
      );
      this.onInfo(
        `capture session=${state.dshSessionId} turn=${state.turn} trace=${result.traceId}`,
      );
    } finally {
      this.deleteTurn(state.dshSession, state.turn);
    }
  }

  private recordCompletedToolOutcomes(
    state: TurnState,
    sessionId: SessionId,
    episodeId: EpisodeId,
  ): void {
    for (const tool of state.toolCalls) {
      const endedAt = tool.endedAt;
      if (endedAt === undefined) continue;
      try {
        this.withLlmRoute(state, () => {
          this.core.recordToolOutcome({
            sessionId,
            episodeId,
            tool: tool.name,
            success: tool.errorCode === undefined,
            errorCode: tool.errorCode,
            durationMs: Math.max(0, endedAt - (tool.startedAt ?? endedAt)),
            ts: endedAt,
          });
        });
      } catch (error) {
        this.warn(`MemOS recordToolOutcome failed for ${tool.name}`, error);
      }
    }
  }

  private handleToolResult(session: DshSessionLike, event: DshSessionEventLike): void {
    const data = asRecord(event.data);
    const turn = readNumber(data, "turn");
    const message = asRecord(data?.["message"]);
    const source = asRecord(message?.["source"]);
    const callId = readString(source, "callId");
    if (turn === undefined || !callId) return;
    const state = this.getTurn(session, turn);
    if (!state) return;

    let tool = state.toolCalls.find((candidate) => candidate.callId === callId);
    if (!tool) {
      tool = {
        callId,
        toolCallId: callId,
        name: "unknown",
        input: undefined,
      };
      state.toolCalls.push(tool);
    }
    const summary = summarizeToolResult(message?.["content"]);
    tool.output = summary.output;
    // DSH may publish a surface replacement for an existing tool result when
    // presentation content is rewritten. It is not a second execution and must
    // not advance failure-burst feedback or replace the original timing.
    if (isSurfaceReplacement(event.surfaceOp)) return;
    const error = asRecord(data?.["error"]);
    const errorCode = readString(error, "code") ?? (summary.failed ? "TOOL_ERROR" : undefined);
    tool.errorCode = errorCode;
    tool.endedAt = event.time;

  }

  private withLlmRoute<T>(
    state: TurnState,
    operation: () => T,
  ): T {
    if (!state.llmRoute || !this.runWithLlmRoute) return operation();
    return this.runWithLlmRoute(state.llmRoute, operation);
  }

  private rememberLlmRoute(
    state: TurnState,
    route: DeepSeekHarnessLlmRoute,
  ): void {
    state.llmRoute = route;
    this.lastLlmRouteBySession.set(state.dshSession, route);
  }

  private withSessionLlmRoute<T>(
    session: DshSessionLike | undefined,
    operation: () => T,
  ): T {
    const route = session === undefined
      ? undefined
      : this.lastLlmRouteBySession.get(session);
    if (!route || !this.runWithLlmRoute) return operation();
    return this.runWithLlmRoute(route, operation);
  }

  private handleCodeDispatchStart(session: DshSessionLike, event: DshSessionEventLike): void {
    const turn = this.activeTurnBySession.get(session);
    const data = asRecord(event.data);
    const callId = readString(data, "subCallId");
    const name = readString(data, "name");
    if (turn === undefined || !callId || !name) return;
    const state = this.getTurn(session, turn);
    if (!state || state.toolCalls.some((tool) => tool.callId === callId)) return;
    state.toolCalls.push({
      callId,
      toolCallId: callId,
      name,
      input: data?.["arguments"],
      startedAt: event.time,
    });
  }

  private handleCodeDispatchResult(session: DshSessionLike, event: DshSessionEventLike): void {
    const turn = this.activeTurnBySession.get(session);
    const data = asRecord(event.data);
    const callId = readString(data, "subCallId");
    if (turn === undefined || !callId) return;
    const state = this.getTurn(session, turn);
    const tool = state?.toolCalls.find((candidate) => candidate.callId === callId);
    if (!state || !tool) return;
    const failed = data?.["isError"] === true;
    tool.output = summarizeContent(data?.["content"]);
    tool.errorCode = failed ? "TOOL_ERROR" : undefined;
    tool.endedAt = event.time;
  }

  private memorySessionIdsFor(session: DshSessionLike): Set<SessionId> {
    const ids = new Set<SessionId>(this.memorySessionsByDsh.get(session));
    for (const state of this.turns.get(session)?.values() ?? []) {
      ids.add(state.memorySessionId);
    }
    return ids;
  }

  private trackMemorySession(session: DshSessionLike, memorySessionId: SessionId): void {
    const owners = this.memorySessionOwners.get(memorySessionId) ?? new Set<DshSessionLike>();
    owners.add(session);
    this.memorySessionOwners.set(memorySessionId, owners);
    const sessions = this.memorySessionsByDsh.get(session) ?? new Set<SessionId>();
    sessions.add(memorySessionId);
    this.memorySessionsByDsh.set(session, sessions);
  }

  private ownsMemorySession(session: DshSessionLike, memorySessionId: SessionId): boolean {
    return this.memorySessionOwners.get(memorySessionId)?.has(session) === true;
  }

  private async waitForMemorySessionClose(memorySessionId: SessionId): Promise<void> {
    const closing = this.closingMemorySessions.get(memorySessionId);
    if (closing) await closing;
  }

  private async releaseMemorySession(
    session: DshSessionLike,
    memorySessionId: SessionId,
  ): Promise<void> {
    const owners = this.memorySessionOwners.get(memorySessionId);
    if (!owners?.delete(session)) return;
    if (owners.size > 0) return;
    this.memorySessionOwners.delete(memorySessionId);

    const closing = (async () => {
      try {
        await this.withSessionLlmRoute(
          session,
          () => this.core.closeSession(memorySessionId),
        );
      } catch (error) {
        this.warn(`MemOS closeSession failed for ${memorySessionId}`, error);
      }
    })();
    this.closingMemorySessions.set(memorySessionId, closing);
    try {
      await closing;
    } finally {
      if (this.closingMemorySessions.get(memorySessionId) === closing) {
        this.closingMemorySessions.delete(memorySessionId);
      }
    }
  }

  private warn(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.onWarn(`${message}: ${detail}`, error);
  }
}

export function createDeepSeekHarnessBridge(
  options: DeepSeekHarnessBridgeOptions,
): DeepSeekHarnessBridge {
  return new DeepSeekHarnessBridge(options);
}

/** Resolve the public DSH provider/model route without touching credentials. */
export function extractDeepSeekHarnessLlmRoute(
  agent: DshAgentLike,
): DeepSeekHarnessLlmRoute | undefined {
  let persisted: ReturnType<NonNullable<DshSessionLike["requestHeader"]>>;
  try {
    persisted = agent.session.requestHeader?.();
  } catch {
    persisted = undefined;
  }
  const config = persisted?.config;
  const provider = nonEmptyString(config?.provider)
    ?? nonEmptyString(agent.options?.provider);
  const model = nonEmptyString(config?.model)
    ?? nonEmptyString(agent.options?.model);
  if (!provider || !model) return undefined;
  const reasoningEffort = nonEmptyString(config?.reasoningEffort)
    ?? nonEmptyString(agent.options?.reasoningEffort);
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    sessionId: agent.session.id,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const candidate = asRecord(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const candidate = asRecord(value)?.[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSurfaceReplacement(
  value: DshSessionEventLike["surfaceOp"],
): value is Exclude<DshSessionEventLike["surfaceOp"], "append" | undefined> {
  return typeof value === "object" && value?.op === "replace";
}

function isUserMessage(value: unknown): value is DshUserMessageLike {
  const record = asRecord(value);
  const source = asRecord(record?.["source"]);
  return record?.["role"] === "user"
    && typeof record["id"] === "string"
    && Array.isArray(record["content"])
    && typeof source?.["kind"] === "string";
}

function userTextFromMessages(messages: readonly DshUserMessageLike[]): string {
  return messages
    .filter((message) => message.source.kind === "user")
    .map((message) => textFromContent(message.content, "text"))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function textFromContent(content: unknown, type: string): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.["type"] === type && typeof record["text"] === "string"
        ? record["text"]
        : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function pushUnique(target: string[], value: string): void {
  if (value && target[target.length - 1] !== value) target.push(value);
}

function optionalJoined(parts: string[]): string | undefined {
  const joined = parts.join("\n\n").trim();
  return joined || undefined;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function summarizeToolResult(content: unknown): ToolResultSummary {
  if (!Array.isArray(content)) return { output: undefined, failed: false };
  const toolResult = content
    .map(asRecord)
    .find((block) => block?.["type"] === "tool-result");
  if (!toolResult) {
    return { output: summarizeContent(content), failed: false };
  }
  return {
    output: summarizeContent(toolResult["content"]),
    failed: toolResult["isError"] === true,
  };
}

function summarizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const text = textFromContent(content, "text");
  if (text) return text;
  return content;
}

function renderRecallContext(raw: string, maxChars: number): string {
  const body = raw.trim();
  if (!body) return "";
  const open = "<memos_context>\n";
  const close = "\n</memos_context>";
  const suffix = "\n\n[Memory context truncated.]";
  const available = Math.max(0, maxChars - open.length - close.length);
  const clipped = body.length <= available
    ? body
    : `${body.slice(0, Math.max(0, available - suffix.length)).trimEnd()}${suffix}`;
  return `${open}${clipped}${close}`;
}
