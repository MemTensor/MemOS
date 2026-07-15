/**
 * OpenCode CLI message types
 * Based on --format json output from `opencode run`
 */

export interface OpenCodeMessageBase {
  type: string;
  timestamp?: number;
  sessionID?: string;
}

/** Step start event */
export interface OpenCodeStepStartMessage extends OpenCodeMessageBase {
  type: 'step_start';
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'step-start';
    snapshot?: string;
  };
}

/** Text content event */
export interface OpenCodeTextMessage extends OpenCodeMessageBase {
  type: 'text';
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'text';
    text: string;
    time?: {
      start: number;
      end: number;
    };
  };
}

/** Tool call event (legacy format) */
export interface OpenCodeToolCallMessage extends OpenCodeMessageBase {
  type: 'tool_call';
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'tool-call';
    tool: string;
    input: unknown;
    time?: {
      start: number;
      end?: number;
    };
  };
}

/** Tool use event - combined tool call and result from OpenCode CLI */
export interface OpenCodeToolUseMessage extends OpenCodeMessageBase {
  type: 'tool_use';
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'tool';
    callID?: string;
    tool: string;
    state: {
      status: 'pending' | 'running' | 'completed' | 'error';
      input?: unknown;
      output?: string;
    };
    time?: {
      start: number;
      end?: number;
    };
  };
}

/** Tool result event */
export interface OpenCodeToolResultMessage extends OpenCodeMessageBase {
  type: 'tool_result';
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'tool-result';
    toolCallID: string;
    output?: string;
    isError?: boolean;
    time?: {
      start: number;
      end: number;
    };
  };
}

/** Step finish event */
export interface OpenCodeStepFinishMessage extends OpenCodeMessageBase {
  type: 'step_finish';
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'step-finish';
    reason: 'stop' | 'end_turn' | 'tool_use' | 'error';
    snapshot?: string;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache?: {
        read: number;
        write: number;
      };
    };
  };
}

/** Error event */
export interface OpenCodeErrorMessage extends OpenCodeMessageBase {
  type: 'error';
  error: string;
  code?: string;
}

/** All OpenCode message types */
export type OpenCodeMessage =
  | OpenCodeStepStartMessage
  | OpenCodeTextMessage
  | OpenCodeToolCallMessage
  | OpenCodeToolUseMessage
  | OpenCodeToolResultMessage
  | OpenCodeStepFinishMessage
  | OpenCodeErrorMessage;

/**
 * Normalized message format for internal use
 */
export interface NormalizedMessage {
  type: 'init' | 'assistant' | 'user' | 'tool_use' | 'tool_result' | 'result';
  sessionId?: string;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  status?: 'success' | 'error';
  error?: string;
  metadata?: {
    model?: string;
    provider?: string;
    durationMs?: number;
    tokens?: {
      input: number;
      output: number;
    };
  };
}

// Re-export as ClaudeMessage for backward compatibility during migration
export type ClaudeMessage = OpenCodeMessage;
export type ClaudeMessageBase = OpenCodeMessageBase;
