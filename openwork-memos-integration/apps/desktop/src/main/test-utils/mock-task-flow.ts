/**
 * Mock task flow utilities for E2E testing.
 * Simulates IPC events without spawning real PTY processes.
 */
import { BrowserWindow } from 'electron';
import type { Task, TaskMessage, TaskStatus } from '@accomplish/shared';
import { updateTaskStatus } from '../store/taskHistory';

// ============================================================================
// Types
// ============================================================================

export type MockScenario =
  | 'success'
  | 'with-tool'
  | 'permission-required'
  | 'question'
  | 'error'
  | 'interrupted';

export interface MockTaskConfig {
  taskId: string;
  prompt: string;
  scenario: MockScenario;
  /** Delay between events in milliseconds */
  delayMs?: number;
}

// ============================================================================
// E2E Mode Detection
// ============================================================================

/**
 * Check if mock task events mode is enabled.
 * Can be set via global flag, CLI arg, or environment variable.
 */
export function isMockTaskEventsEnabled(): boolean {
  return (
    (global as Record<string, unknown>).E2E_MOCK_TASK_EVENTS === true ||
    process.env.E2E_MOCK_TASK_EVENTS === '1'
  );
}

// ============================================================================
// Scenario Detection
// ============================================================================

/**
 * Keywords that trigger specific test scenarios.
 * Using explicit prefixes to avoid false positives from natural language.
 */
const SCENARIO_KEYWORDS: Record<MockScenario, string[]> = {
  success: ['__e2e_success__', 'test success'],
  'with-tool': ['__e2e_tool__', 'use tool', 'search files'],
  'permission-required': ['__e2e_permission__', 'write file', 'create file'],
  question: ['__e2e_question__'],
  error: ['__e2e_error__', 'cause error', 'trigger failure'],
  interrupted: ['__e2e_interrupt__', 'stop task', 'cancel task'],
};

/**
 * Detect the appropriate mock scenario from the prompt text.
 * Checks for explicit keywords in priority order.
 */
export function detectScenarioFromPrompt(prompt: string): MockScenario {
  const promptLower = prompt.toLowerCase();

  // Check scenarios in priority order (error/interrupt first to handle edge cases)
  const priorityOrder: MockScenario[] = [
    'error',
    'interrupted',
    'question',
    'permission-required',
    'with-tool',
    'success',
  ];

  for (const scenario of priorityOrder) {
    const keywords = SCENARIO_KEYWORDS[scenario];
    if (keywords.some(keyword => promptLower.includes(keyword.toLowerCase()))) {
      return scenario;
    }
  }

  // Default to success
  return 'success';
}

// ============================================================================
// Utility Functions
// ============================================================================

function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Mock Task Execution
// ============================================================================

/**
 * Execute a mock task flow by emitting simulated IPC events.
 * This allows E2E tests to verify UI behavior without real API calls.
 */
export async function executeMockTaskFlow(
  window: BrowserWindow,
  config: MockTaskConfig
): Promise<void> {
  const { taskId, prompt, scenario, delayMs = 100 } = config;

  // Verify window is still valid
  if (window.isDestroyed()) {
    console.warn('[MockTaskFlow] Window destroyed, skipping mock flow');
    return;
  }

  const sendEvent = (channel: string, data: unknown) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, data);
    }
  };

  // Initial progress event
  sendEvent('task:progress', { taskId, stage: 'init' });
  await sleep(delayMs);

  // Assistant acknowledgment message
  sendEvent('task:update', {
    taskId,
    type: 'message',
    message: {
      id: createMessageId(),
      type: 'assistant',
      content: `I'll help you with: ${prompt}`,
      timestamp: new Date().toISOString(),
    },
  });
  await sleep(delayMs);

  // Execute scenario-specific flow
  await executeScenario(sendEvent, taskId, scenario, delayMs);
}

/**
 * Execute the scenario-specific event sequence.
 */
async function executeScenario(
  sendEvent: (channel: string, data: unknown) => void,
  taskId: string,
  scenario: MockScenario,
  delayMs: number
): Promise<void> {
  switch (scenario) {
    case 'success':
      await executeSuccessScenario(sendEvent, taskId, delayMs);
      break;

    case 'with-tool':
      await executeToolScenario(sendEvent, taskId, delayMs);
      break;

    case 'permission-required':
      executePermissionScenario(sendEvent, taskId);
      break;

    case 'question':
      executeQuestionScenario(sendEvent, taskId);
      break;

    case 'error':
      executeErrorScenario(sendEvent, taskId);
      break;

    case 'interrupted':
      await executeInterruptedScenario(sendEvent, taskId, delayMs);
      break;
  }
}

async function executeSuccessScenario(
  sendEvent: (channel: string, data: unknown) => void,
  taskId: string,
  delayMs: number
): Promise<void> {
  sendEvent('task:update', {
    taskId,
    type: 'message',
    message: {
      id: createMessageId(),
      type: 'assistant',
      content: 'Task completed successfully.',
      timestamp: new Date().toISOString(),
    },
  });
  await sleep(delayMs);

  // Update task history status before sending completion event
  updateTaskStatus(taskId, 'completed', new Date().toISOString());

  sendEvent('task:update', {
    taskId,
    type: 'complete',
    result: { status: 'success', sessionId: `session_${taskId}` },
  });
}

async function executeToolScenario(
  sendEvent: (channel: string, data: unknown) => void,
  taskId: string,
  delayMs: number
): Promise<void> {
  // Simulate tool usage
  sendEvent('task:update:batch', {
    taskId,
    messages: [
      {
        id: createMessageId(),
        type: 'tool',
        content: 'Reading files',
        toolName: 'Read',
        timestamp: new Date().toISOString(),
      },
      {
        id: createMessageId(),
        type: 'tool',
        content: 'Searching code',
        toolName: 'Grep',
        timestamp: new Date().toISOString(),
      },
    ],
  });
  await sleep(delayMs * 2);

  sendEvent('task:update', {
    taskId,
    type: 'message',
    message: {
      id: createMessageId(),
      type: 'assistant',
      content: 'Found the information using available tools.',
      timestamp: new Date().toISOString(),
    },
  });
  await sleep(delayMs);

  // Update task history status before sending completion event
  updateTaskStatus(taskId, 'completed', new Date().toISOString());

  sendEvent('task:update', {
    taskId,
    type: 'complete',
    result: { status: 'success', sessionId: `session_${taskId}` },
  });
}

function executePermissionScenario(
  sendEvent: (channel: string, data: unknown) => void,
  taskId: string
): void {
  // Send permission request - task waits for user response
  // Tests should call permission:respond to continue the flow
  sendEvent('permission:request', {
    id: `perm_${Date.now()}`,
    taskId,
    type: 'file',
    question: 'Allow file write?',
    toolName: 'Write',
    fileOperation: 'create',
    filePath: '/test/output.txt',
    timestamp: new Date().toISOString(),
  });
}

function executeQuestionScenario(
  sendEvent: (channel: string, data: unknown) => void,
  taskId: string
): void {
  // Send question permission request - task waits for user to select an option
  sendEvent('permission:request', {
    id: `perm_${Date.now()}`,
    taskId,
    type: 'question',
    header: 'Test Question',
    question: 'Which option do you prefer?',
    options: [
      { label: 'Option A', description: 'First option for testing' },
      { label: 'Option B', description: 'Second option for testing' },
      { label: 'Other', description: 'Enter a custom response' },
    ],
    multiSelect: false,
    timestamp: new Date().toISOString(),
  });
}

function executeErrorScenario(
  sendEvent: (channel: string, data: unknown) => void,
  taskId: string
): void {
  // Update task history status before sending error event
  updateTaskStatus(taskId, 'failed', new Date().toISOString());

  sendEvent('task:update', {
    taskId,
    type: 'error',
    error: 'Command execution failed: File not found',
  });
}

async function executeInterruptedScenario(
  sendEvent: (channel: string, data: unknown) => void,
  taskId: string,
  delayMs: number
): Promise<void> {
  sendEvent('task:update', {
    taskId,
    type: 'message',
    message: {
      id: createMessageId(),
      type: 'assistant',
      content: 'Task was interrupted by user.',
      timestamp: new Date().toISOString(),
    },
  });
  await sleep(delayMs);

  // Update task history status before sending completion event
  updateTaskStatus(taskId, 'interrupted', new Date().toISOString());

  sendEvent('task:update', {
    taskId,
    type: 'complete',
    result: { status: 'interrupted', sessionId: `session_${taskId}` },
  });
}

// ============================================================================
// Task Creation
// ============================================================================

/**
 * Create a mock Task object for immediate return from task:start handler.
 */
export function createMockTask(taskId: string, prompt: string): Task {
  const initialMessage: TaskMessage = {
    id: createMessageId(),
    type: 'user',
    content: prompt,
    timestamp: new Date().toISOString(),
  };

  return {
    id: taskId,
    prompt,
    status: 'running',
    messages: [initialMessage],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
}
