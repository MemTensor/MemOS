/**
 * Task-related types for execution management
 */

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface TaskConfig {
  /** The task prompt/description */
  prompt: string;
  /** Optional task ID to correlate events */
  taskId?: string;
  /** Working directory for Claude Code operations */
  workingDirectory?: string;
  /** List of allowed tools */
  allowedTools?: string[];
  /** System prompt to append */
  systemPromptAppend?: string;
  /** JSON schema for structured output */
  outputSchema?: object;
  /** Session ID for resuming */
  sessionId?: string;
}

export interface Task {
  id: string;
  prompt: string;
  /** AI-generated short summary of the task (displayed in history) */
  summary?: string;
  status: TaskStatus;
  sessionId?: string;
  messages: TaskMessage[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: TaskResult;
}

export interface TaskAttachment {
  type: 'screenshot' | 'json';
  data: string; // base64 for images, JSON string for data
  label?: string; // e.g., "Screenshot after clicking Submit"
}

export interface TaskMessage {
  id: string;
  type: 'assistant' | 'user' | 'tool' | 'system';
  content: string;
  toolName?: string;
  toolInput?: unknown;
  timestamp: string;
  /** Attachments like screenshots captured during browser automation */
  attachments?: TaskAttachment[];
}

export interface TaskResult {
  status: 'success' | 'error' | 'interrupted';
  sessionId?: string;
  durationMs?: number;
  error?: string;
}

export interface TaskProgress {
  taskId: string;
  stage: 'init' | 'thinking' | 'tool-use' | 'waiting' | 'complete';
  toolName?: string;
  toolInput?: unknown;
  percentage?: number;
  message?: string;
}

export interface TaskUpdateEvent {
  taskId: string;
  type: 'message' | 'progress' | 'complete' | 'error';
  message?: TaskMessage;
  progress?: TaskProgress;
  result?: TaskResult;
  error?: string;
}
