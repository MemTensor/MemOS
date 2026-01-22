import { ipcMain, BrowserWindow, shell, app } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { URL } from 'url';
import {
  isOpenCodeCliInstalled,
  getOpenCodeCliVersion,
} from '../opencode/adapter';
import {
  getTaskManager,
  disposeTaskManager,
  type TaskCallbacks,
} from '../opencode/task-manager';
import {
  getTasks,
  getTask,
  saveTask,
  updateTaskStatus,
  updateTaskSessionId,
  updateTaskSummary,
  addTaskMessage,
  deleteTask,
  clearHistory,
} from '../store/taskHistory';
import { generateTaskSummary } from '../services/summarizer';
import { getMemoryContextForPrompt, rememberTask } from '../services/memory';
import {
  storeApiKey,
  getApiKey,
  deleteApiKey,
  getAllApiKeys,
  hasAnyApiKey,
  listStoredCredentials,
} from '../store/secureStorage';
import {
  getDebugMode,
  setDebugMode,
  getAppSettings,
  getOnboardingComplete,
  setOnboardingComplete,
  getSelectedModel,
  setSelectedModel,
  getOllamaConfig,
  setOllamaConfig,
  getLiteLLMConfig,
  setLiteLLMConfig,
} from '../store/appSettings';
import { getDesktopConfig } from '../config';
import {
  startPermissionApiServer,
  startQuestionApiServer,
  initPermissionApi,
  resolvePermission,
  resolveQuestion,
  isFilePermissionRequest,
  isQuestionRequest,
} from '../permission-api';
import type {
  TaskConfig,
  PermissionResponse,
  OpenCodeMessage,
  TaskMessage,
  TaskResult,
  TaskStatus,
  SelectedModel,
  OllamaConfig,
  LiteLLMConfig,
} from '@accomplish/shared';
import { DEFAULT_PROVIDERS } from '@accomplish/shared';
import {
  normalizeIpcError,
  permissionResponseSchema,
  resumeSessionSchema,
  taskConfigSchema,
  validate,
} from './validation';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { fromIni } from '@aws-sdk/credential-providers';
import {
  isMockTaskEventsEnabled,
  createMockTask,
  executeMockTaskFlow,
  detectScenarioFromPrompt,
} from '../test-utils/mock-task-flow';

const MAX_TEXT_LENGTH = 8000;
const ALLOWED_API_KEY_PROVIDERS = new Set(['anthropic', 'openai', 'openrouter', 'google', 'xai', 'deepseek', 'zai', 'custom', 'bedrock', 'litellm']);
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;

interface OllamaModel {
  id: string;
  displayName: string;
  size: number;
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Message batching configuration
const MESSAGE_BATCH_DELAY_MS = 50;

// Per-task message batching state
interface MessageBatcher {
  pendingMessages: TaskMessage[];
  timeout: NodeJS.Timeout | null;
  taskId: string;
  flush: () => void;
}

const messageBatchers = new Map<string, MessageBatcher>();

function createMessageBatcher(
  taskId: string,
  forwardToRenderer: (channel: string, data: unknown) => void,
  addTaskMessage: (taskId: string, message: TaskMessage) => void
): MessageBatcher {
  const batcher: MessageBatcher = {
    pendingMessages: [],
    timeout: null,
    taskId,
    flush: () => {
      if (batcher.pendingMessages.length === 0) return;

      // Send all pending messages in one IPC call
      forwardToRenderer('task:update:batch', {
        taskId,
        messages: batcher.pendingMessages,
      });

      // Also persist each message to history
      for (const msg of batcher.pendingMessages) {
        addTaskMessage(taskId, msg);
      }

      batcher.pendingMessages = [];
      if (batcher.timeout) {
        clearTimeout(batcher.timeout);
        batcher.timeout = null;
      }
    },
  };

  messageBatchers.set(taskId, batcher);
  return batcher;
}

function queueMessage(
  taskId: string,
  message: TaskMessage,
  forwardToRenderer: (channel: string, data: unknown) => void,
  addTaskMessage: (taskId: string, message: TaskMessage) => void
): void {
  let batcher = messageBatchers.get(taskId);
  if (!batcher) {
    batcher = createMessageBatcher(taskId, forwardToRenderer, addTaskMessage);
  }

  batcher.pendingMessages.push(message);

  // Set up or reset the batch timer
  if (batcher.timeout) {
    clearTimeout(batcher.timeout);
  }

  batcher.timeout = setTimeout(() => {
    batcher.flush();
  }, MESSAGE_BATCH_DELAY_MS);
}

function flushAndCleanupBatcher(taskId: string): void {
  const batcher = messageBatchers.get(taskId);
  if (batcher) {
    batcher.flush();
    messageBatchers.delete(taskId);
  }
}

function assertTrustedWindow(window: BrowserWindow | null): BrowserWindow {
  if (!window || window.isDestroyed()) {
    throw new Error('Untrusted window');
  }

  const focused = BrowserWindow.getFocusedWindow();
  if (BrowserWindow.getAllWindows().length > 1 && focused && focused.id !== window.id) {
    throw new Error('IPC request must originate from the focused window');
  }

  return window;
}

function sanitizeString(input: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof input !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${field} exceeds maximum length`);
  }
  return trimmed;
}

function applyMemoryContext(config: TaskConfig, memoryContext: string | null): TaskConfig {
  if (!memoryContext) return config;

  const combined = [config.systemPromptAppend, memoryContext]
    .filter(Boolean)
    .join('\n\n');

  const trimmed = combined.length > MAX_TEXT_LENGTH
    ? combined.slice(0, Math.max(0, MAX_TEXT_LENGTH - 3)) + '...'
    : combined;

  if (trimmed.length !== combined.length) {
    console.warn('[Memory] systemPromptAppend truncated to MAX_TEXT_LENGTH');
  }

  return { ...config, systemPromptAppend: trimmed };
}

function validateTaskConfig(config: TaskConfig): TaskConfig {
  const prompt = sanitizeString(config.prompt, 'prompt');
  const validated: TaskConfig = { prompt };

  if (config.taskId) {
    validated.taskId = sanitizeString(config.taskId, 'taskId', 128);
  }
  if (config.sessionId) {
    validated.sessionId = sanitizeString(config.sessionId, 'sessionId', 128);
  }
  if (config.workingDirectory) {
    validated.workingDirectory = sanitizeString(config.workingDirectory, 'workingDirectory', 1024);
  }
  if (Array.isArray(config.allowedTools)) {
    validated.allowedTools = config.allowedTools
      .filter((tool): tool is string => typeof tool === 'string')
      .map((tool) => sanitizeString(tool, 'allowedTools', 64))
      .slice(0, 20);
  }
  if (config.systemPromptAppend) {
    validated.systemPromptAppend = sanitizeString(
      config.systemPromptAppend,
      'systemPromptAppend',
      MAX_TEXT_LENGTH
    );
  }
  if (config.outputSchema && typeof config.outputSchema === 'object') {
    validated.outputSchema = config.outputSchema;
  }

  return validated;
}

/**
 * Check if E2E auth bypass is enabled via global flag, command-line argument, or environment variable
 * Global flag is set by Playwright's app.evaluate() and is most reliable across platforms
 */
function isE2ESkipAuthEnabled(): boolean {
  return (
    (global as Record<string, unknown>).E2E_SKIP_AUTH === true ||
    process.argv.includes('--e2e-skip-auth') ||
    process.env.E2E_SKIP_AUTH === '1'
  );
}

function handle<Args extends unknown[], ReturnType = unknown>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => ReturnType
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as Args));
    } catch (error) {
      console.error(`IPC handler ${channel} failed`, error);
      throw normalizeIpcError(error);
    }
  });
}

/**
 * Register all IPC handlers
 */
export function registerIPCHandlers(): void {
  const taskManager = getTaskManager();

  // Start the permission API server for file-permission MCP
  // Initialize when we have a window (deferred until first task:start)
  let permissionApiInitialized = false;

  // Task: Start a new task
  handle('task:start', async (event: IpcMainInvokeEvent, config: TaskConfig) => {
    const window = assertTrustedWindow(BrowserWindow.fromWebContents(event.sender));
    const sender = event.sender;
    const validatedConfig = validateTaskConfig(config);

    // Initialize permission API server (once, when we have a window)
    if (!permissionApiInitialized) {
      initPermissionApi(window, () => taskManager.getActiveTaskId());
      startPermissionApiServer();
      startQuestionApiServer();
      permissionApiInitialized = true;
    }

    const taskId = createTaskId();
    const memoryContext = await getMemoryContextForPrompt(validatedConfig.prompt, taskId);
    const configWithMemory = applyMemoryContext(validatedConfig, memoryContext);

    // E2E Mock Mode: Return mock task and emit simulated events
    if (isMockTaskEventsEnabled()) {
      const mockTask = createMockTask(taskId, validatedConfig.prompt);
      const scenario = detectScenarioFromPrompt(validatedConfig.prompt);

      // Save task to history so Execution page can load it
      saveTask(mockTask);

      // Execute mock flow asynchronously (sends IPC events)
      void executeMockTaskFlow(window, {
        taskId,
        prompt: validatedConfig.prompt,
        scenario,
        delayMs: 50,
      });

      return mockTask;
    }

    // Setup event forwarding to renderer
    const forwardToRenderer = (channel: string, data: unknown) => {
      if (!window.isDestroyed() && !sender.isDestroyed()) {
        sender.send(channel, data);
      }
    };

    // Create task-scoped callbacks for the TaskManager
    const callbacks: TaskCallbacks = {
      onMessage: (message: OpenCodeMessage) => {
        const taskMessage = toTaskMessage(message);
        if (!taskMessage) return;

        // Queue message for batching instead of immediate send
        queueMessage(taskId, taskMessage, forwardToRenderer, addTaskMessage);
      },

      onProgress: (progress: { stage: string; message?: string }) => {
        forwardToRenderer('task:progress', {
          taskId,
          ...progress,
        });
      },

      onPermissionRequest: (request: unknown) => {
        // Flush pending messages before showing permission request
        flushAndCleanupBatcher(taskId);
        forwardToRenderer('permission:request', request);
      },

      onComplete: (result: TaskResult) => {
        // Flush any pending messages before completing
        flushAndCleanupBatcher(taskId);

        forwardToRenderer('task:update', {
          taskId,
          type: 'complete',
          result,
        });

        // Map result status to task status
        let taskStatus: TaskStatus;
        if (result.status === 'success') {
          taskStatus = 'completed';
        } else if (result.status === 'interrupted') {
          taskStatus = 'interrupted';
        } else {
          taskStatus = 'failed';
        }

        // Update task status in history
        updateTaskStatus(taskId, taskStatus, new Date().toISOString());

        // Update session ID if available (important for interrupted tasks to allow continuation)
        const sessionId = result.sessionId || taskManager.getSessionId(taskId);
        if (sessionId) {
          updateTaskSessionId(taskId, sessionId);
        }

        if (result.status !== 'error') {
          const storedTask = getTask(taskId);
          if (storedTask) {
            void rememberTask(storedTask);
          }
        }
      },

      onError: (error: Error) => {
        // Flush any pending messages before error
        flushAndCleanupBatcher(taskId);

        forwardToRenderer('task:update', {
          taskId,
          type: 'error',
          error: error.message,
        });

        // Update task status in history
        updateTaskStatus(taskId, 'failed', new Date().toISOString());
      },

      onDebug: (log: { type: string; message: string; data?: unknown }) => {
        if (getDebugMode()) {
          forwardToRenderer('debug:log', {
            taskId,
            timestamp: new Date().toISOString(),
            ...log,
          });
        }
      },

      onStatusChange: (status: TaskStatus) => {
        // Notify renderer of status change (e.g., queued -> running)
        forwardToRenderer('task:status-change', {
          taskId,
          status,
        });
        // Update task status in history
        updateTaskStatus(taskId, status, new Date().toISOString());
      },
    };

    // Start the task via TaskManager (creates isolated adapter or queues if busy)
    const task = await taskManager.startTask(taskId, configWithMemory, callbacks);

    // Add initial user message with the prompt to the chat
    const initialUserMessage: TaskMessage = {
      id: createMessageId(),
      type: 'user',
      content: validatedConfig.prompt,
      timestamp: new Date().toISOString(),
    };
    task.messages = [initialUserMessage];

    // Save task to history (includes the initial user message)
    saveTask(task);

    // Generate AI summary asynchronously (don't block task execution)
    generateTaskSummary(validatedConfig.prompt)
      .then((summary) => {
        updateTaskSummary(taskId, summary);
        forwardToRenderer('task:summary', { taskId, summary });
      })
      .catch((err) => {
        console.warn('[IPC] Failed to generate task summary:', err);
      });

    return task;
  });

  // Task: Cancel current task (running or queued)
  handle('task:cancel', async (_event: IpcMainInvokeEvent, taskId?: string) => {
    if (!taskId) return;

    // Check if it's a queued task first
    if (taskManager.isTaskQueued(taskId)) {
      taskManager.cancelQueuedTask(taskId);
      updateTaskStatus(taskId, 'cancelled', new Date().toISOString());
      return;
    }

    // Otherwise cancel the running task
    if (taskManager.hasActiveTask(taskId)) {
      await taskManager.cancelTask(taskId);
      updateTaskStatus(taskId, 'cancelled', new Date().toISOString());
    }
  });

  // Task: Interrupt current task (graceful Ctrl+C, doesn't kill process)
  handle('task:interrupt', async (_event: IpcMainInvokeEvent, taskId?: string) => {
    if (!taskId) return;

    if (taskManager.hasActiveTask(taskId)) {
      await taskManager.interruptTask(taskId);
      // Note: Don't change task status - task is still running, just interrupted
      console.log(`[IPC] Task ${taskId} interrupted`);
    }
  });

  // Task: Get task from history
  handle('task:get', async (_event: IpcMainInvokeEvent, taskId: string) => {
    return getTask(taskId) || null;
  });

  // Task: List tasks from history
  handle('task:list', async (_event: IpcMainInvokeEvent) => {
    return getTasks();
  });

  // Task: Delete task from history
  handle('task:delete', async (_event: IpcMainInvokeEvent, taskId: string) => {
    deleteTask(taskId);
  });

  // Task: Clear all history
  handle('task:clear-history', async (_event: IpcMainInvokeEvent) => {
    clearHistory();
  });

  // Permission: Respond to permission request
  handle('permission:respond', async (_event: IpcMainInvokeEvent, response: PermissionResponse) => {
    const parsedResponse = validate(permissionResponseSchema, response);
    const { taskId, decision, requestId } = parsedResponse;

    // Check if this is a file permission request from the MCP server
    if (requestId && isFilePermissionRequest(requestId)) {
      const allowed = decision === 'allow';
      const resolved = resolvePermission(requestId, allowed);
      if (resolved) {
        console.log(`[IPC] File permission request ${requestId} resolved: ${allowed ? 'allowed' : 'denied'}`);
        return;
      }
      // If not found in pending, fall through to standard handling
      console.warn(`[IPC] File permission request ${requestId} not found in pending requests`);
    }

    // Check if this is a question request from the MCP server
    if (requestId && isQuestionRequest(requestId)) {
      const denied = decision === 'deny';
      const resolved = resolveQuestion(requestId, {
        selectedOptions: parsedResponse.selectedOptions,
        customText: parsedResponse.customText,
        denied,
      });
      if (resolved) {
        console.log(`[IPC] Question request ${requestId} resolved: ${denied ? 'denied' : 'answered'}`);
        return;
      }
      // If not found in pending, fall through to standard handling
      console.warn(`[IPC] Question request ${requestId} not found in pending requests`);
    }

    // Check if the task is still active
    if (!taskManager.hasActiveTask(taskId)) {
      console.warn(`[IPC] Permission response for inactive task ${taskId}`);
      return;
    }

    if (decision === 'allow') {
      // Send the response to the correct task's CLI
      const message = parsedResponse.selectedOptions?.join(', ') || parsedResponse.message || 'yes';
      const sanitizedMessage = sanitizeString(message, 'permissionResponse', 1024);
      await taskManager.sendResponse(taskId, sanitizedMessage);
    } else {
      // Send denial to the correct task
      await taskManager.sendResponse(taskId, 'no');
    }
  });

  // Session: Resume (continue conversation)
  handle('session:resume', async (event: IpcMainInvokeEvent, sessionId: string, prompt: string, existingTaskId?: string) => {
    const window = assertTrustedWindow(BrowserWindow.fromWebContents(event.sender));
    const sender = event.sender;
    const validatedSessionId = sanitizeString(sessionId, 'sessionId', 128);
    const validatedPrompt = sanitizeString(prompt, 'prompt');
    const validatedExistingTaskId = existingTaskId
      ? sanitizeString(existingTaskId, 'taskId', 128)
      : undefined;

    // Use existing task ID or create a new one
    const taskId = validatedExistingTaskId || createTaskId();

    // Persist the user's follow-up message to task history
    if (validatedExistingTaskId) {
      const userMessage: TaskMessage = {
        id: createMessageId(),
        type: 'user',
        content: validatedPrompt,
        timestamp: new Date().toISOString(),
      };
      addTaskMessage(validatedExistingTaskId, userMessage);
    }

    // Setup event forwarding to renderer
    const forwardToRenderer = (channel: string, data: unknown) => {
      if (!window.isDestroyed() && !sender.isDestroyed()) {
        sender.send(channel, data);
      }
    };

    // Create task-scoped callbacks for the TaskManager (with batching for performance)
    const callbacks: TaskCallbacks = {
      onMessage: (message: OpenCodeMessage) => {
        const taskMessage = toTaskMessage(message);
        if (!taskMessage) return;

        // Queue message for batching instead of immediate send
        queueMessage(taskId, taskMessage, forwardToRenderer, addTaskMessage);
      },

      onProgress: (progress: { stage: string; message?: string }) => {
        forwardToRenderer('task:progress', {
          taskId,
          ...progress,
        });
      },

      onPermissionRequest: (request: unknown) => {
        // Flush pending messages before showing permission request
        flushAndCleanupBatcher(taskId);
        forwardToRenderer('permission:request', request);
      },

      onComplete: (result: TaskResult) => {
        // Flush any pending messages before completing
        flushAndCleanupBatcher(taskId);

        forwardToRenderer('task:update', {
          taskId,
          type: 'complete',
          result,
        });

        // Map result status to task status
        let taskStatus: TaskStatus;
        if (result.status === 'success') {
          taskStatus = 'completed';
        } else if (result.status === 'interrupted') {
          taskStatus = 'interrupted';
        } else {
          taskStatus = 'failed';
        }

        // Update task status in history
        updateTaskStatus(taskId, taskStatus, new Date().toISOString());

        // Update session ID if available (important for interrupted tasks to allow continuation)
        const newSessionId = result.sessionId || taskManager.getSessionId(taskId);
        if (newSessionId) {
          updateTaskSessionId(taskId, newSessionId);
        }

        if (result.status !== 'error') {
          const storedTask = getTask(taskId);
          if (storedTask) {
            void rememberTask(storedTask);
          }
        }
      },

      onError: (error: Error) => {
        // Flush any pending messages before error
        flushAndCleanupBatcher(taskId);

        forwardToRenderer('task:update', {
          taskId,
          type: 'error',
          error: error.message,
        });

        // Update task status in history
        updateTaskStatus(taskId, 'failed', new Date().toISOString());
      },

      onDebug: (log: { type: string; message: string; data?: unknown }) => {
        if (getDebugMode()) {
          forwardToRenderer('debug:log', {
            taskId,
            timestamp: new Date().toISOString(),
            ...log,
          });
        }
      },

      onStatusChange: (status: TaskStatus) => {
        // Notify renderer of status change (e.g., queued -> running)
        forwardToRenderer('task:status-change', {
          taskId,
          status,
        });
        // Update task status in history
        updateTaskStatus(taskId, status, new Date().toISOString());
      },
    };

    const memoryContext = await getMemoryContextForPrompt(validatedPrompt, taskId);
    const taskConfigWithMemory = applyMemoryContext(
      {
        prompt: validatedPrompt,
        sessionId: validatedSessionId,
        taskId,
      },
      memoryContext
    );

    // Start the task via TaskManager with sessionId for resume (creates isolated adapter or queues if busy)
    const task = await taskManager.startTask(taskId, taskConfigWithMemory, callbacks);

    // Update task status in history (whether running or queued)
    if (validatedExistingTaskId) {
      updateTaskStatus(validatedExistingTaskId, task.status, new Date().toISOString());
    }

    return task;
  });

  // Settings: Get API keys
  // Note: In production, this should fetch from backend to get metadata
  // The actual keys are stored locally in secure storage
  handle('settings:api-keys', async (_event: IpcMainInvokeEvent) => {
    const storedCredentials = await listStoredCredentials();

    return storedCredentials
      .filter((credential) => credential.account.startsWith('apiKey:'))
      .map((credential) => {
        const provider = credential.account.replace('apiKey:', '');

        // Handle Bedrock specially - it stores JSON credentials
        let keyPrefix = '';
        if (provider === 'bedrock') {
          try {
            const parsed = JSON.parse(credential.password);
            if (parsed.authType === 'accessKeys') {
              keyPrefix = `${parsed.accessKeyId?.substring(0, 8) || 'AKIA'}...`;
            } else if (parsed.authType === 'profile') {
              keyPrefix = `Profile: ${parsed.profileName || 'default'}`;
            }
          } catch {
            keyPrefix = 'AWS Credentials';
          }
        } else {
          keyPrefix =
            credential.password && credential.password.length > 0
              ? `${credential.password.substring(0, 8)}...`
              : '';
        }

        return {
          id: `local-${provider}`,
          provider,
          label: provider === 'bedrock' ? 'AWS Credentials' : 'Local API Key',
          keyPrefix,
          isActive: true,
          createdAt: new Date().toISOString(),
        };
      });
  });

  // Settings: Add API key (stores securely in OS keychain)
  handle(
    'settings:add-api-key',
    async (_event: IpcMainInvokeEvent, provider: string, key: string, label?: string) => {
      if (!ALLOWED_API_KEY_PROVIDERS.has(provider)) {
        throw new Error('Unsupported API key provider');
      }
      const sanitizedKey = sanitizeString(key, 'apiKey', 256);
      const sanitizedLabel = label ? sanitizeString(label, 'label', 128) : undefined;

      // Store the API key securely in OS keychain
      await storeApiKey(provider, sanitizedKey);

      return {
        id: `local-${provider}`,
        provider,
        label: sanitizedLabel || 'Local API Key',
        keyPrefix: sanitizedKey.substring(0, 8) + '...',
        isActive: true,
        createdAt: new Date().toISOString(),
      };
    }
  );

  // Settings: Remove API key
  handle('settings:remove-api-key', async (_event: IpcMainInvokeEvent, id: string) => {
    // Extract provider from id (format: local-{provider})
    const sanitizedId = sanitizeString(id, 'id', 128);
    const provider = sanitizedId.replace('local-', '');
    await deleteApiKey(provider);
  });

  // API Key: Check if API key exists
  handle('api-key:exists', async (_event: IpcMainInvokeEvent) => {
    const apiKey = await getApiKey('anthropic');
    return Boolean(apiKey);
  });

  // API Key: Set API key
  handle('api-key:set', async (_event: IpcMainInvokeEvent, key: string) => {
    const sanitizedKey = sanitizeString(key, 'apiKey', 256);
    await storeApiKey('anthropic', sanitizedKey);
    console.log('[API Key] Key set', { keyPrefix: sanitizedKey.substring(0, 8) });
  });

  // API Key: Get API key
  handle('api-key:get', async (_event: IpcMainInvokeEvent) => {
    return getApiKey('anthropic');
  });

  // API Key: Validate API key by making a test request
  handle('api-key:validate', async (_event: IpcMainInvokeEvent, key: string) => {
    const sanitizedKey = sanitizeString(key, 'apiKey', 256);
    console.log('[API Key] Validation requested');

    try {
      // Make a simple API call to validate the key
      const response = await fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': sanitizedKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'test' }],
          }),
        },
        API_KEY_VALIDATION_TIMEOUT_MS
      );

      if (response.ok) {
        console.log('[API Key] Validation succeeded');
        return { valid: true };
      }

      const errorData = await response.json().catch(() => ({}));
      const errorMessage = (errorData as { error?: { message?: string } })?.error?.message || `API returned status ${response.status}`;

      console.warn('[API Key] Validation failed', { status: response.status, error: errorMessage });

      return { valid: false, error: errorMessage };
    } catch (error) {
      console.error('[API Key] Validation error', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof Error && error.name === 'AbortError') {
        return { valid: false, error: 'Request timed out. Please check your internet connection and try again.' };
      }
      return { valid: false, error: 'Failed to validate API key. Check your internet connection.' };
    }
  });

  // API Key: Validate API key for any provider
  handle('api-key:validate-provider', async (_event: IpcMainInvokeEvent, provider: string, key: string) => {
    if (!ALLOWED_API_KEY_PROVIDERS.has(provider)) {
      return { valid: false, error: 'Unsupported provider' };
    }
    const sanitizedKey = sanitizeString(key, 'apiKey', 256);
    console.log(`[API Key] Validation requested for provider: ${provider}`);

    try {
      let response: Response;

      switch (provider) {
        case 'anthropic':
          response = await fetchWithTimeout(
            'https://api.anthropic.com/v1/messages',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': sanitizedKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: 'claude-3-haiku-20240307',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'test' }],
              }),
            },
            API_KEY_VALIDATION_TIMEOUT_MS
          );
          break;

        case 'openai':
          response = await fetchWithTimeout(
            'https://api.openai.com/v1/models',
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${sanitizedKey}`,
              },
            },
            API_KEY_VALIDATION_TIMEOUT_MS
          );
          break;

        case 'openrouter':
          response = await fetchWithTimeout(
            'https://openrouter.ai/api/v1/models',
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${sanitizedKey}`,
              },
            },
            API_KEY_VALIDATION_TIMEOUT_MS
          );
          break;

        case 'google':
          response = await fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${sanitizedKey}`,
            {
              method: 'GET',
            },
            API_KEY_VALIDATION_TIMEOUT_MS
          );
          break;

        case 'xai':
          response = await fetchWithTimeout(
            'https://api.x.ai/v1/models',
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${sanitizedKey}`,
              },
            },
            API_KEY_VALIDATION_TIMEOUT_MS
          );
          break;

        case 'deepseek':
          response = await fetchWithTimeout(
            'https://api.deepseek.com/models',
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${sanitizedKey}`,
              },
            },
            API_KEY_VALIDATION_TIMEOUT_MS
          );
          break;

        // Z.AI Coding Plan uses the same validation as standard API
        case 'zai':
          response = await fetchWithTimeout(
            'https://open.bigmodel.cn/api/paas/v4/models',
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${sanitizedKey}`,
              },
            },
            API_KEY_VALIDATION_TIMEOUT_MS
          );
          break;

        default:
          // For 'custom' provider, skip validation
          console.log('[API Key] Skipping validation for custom provider');
          return { valid: true };
      }

      if (response.ok) {
        console.log(`[API Key] Validation succeeded for ${provider}`);
        return { valid: true };
      }

      const errorData = await response.json().catch(() => ({}));
      const errorMessage = (errorData as { error?: { message?: string } })?.error?.message || `API returned status ${response.status}`;

      console.warn(`[API Key] Validation failed for ${provider}`, { status: response.status, error: errorMessage });
      return { valid: false, error: errorMessage };
    } catch (error) {
      console.error(`[API Key] Validation error for ${provider}`, { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof Error && error.name === 'AbortError') {
        return { valid: false, error: 'Request timed out. Please check your internet connection and try again.' };
      }
      return { valid: false, error: 'Failed to validate API key. Check your internet connection.' };
    }
  });

  // Bedrock: Validate AWS credentials
  handle('bedrock:validate', async (_event: IpcMainInvokeEvent, credentials: string) => {
    console.log('[Bedrock] Validation requested');

    try {
      const parsed = JSON.parse(credentials);
      let client: BedrockClient;

      if (parsed.authType === 'accessKeys') {
        // Access key authentication
        const awsCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } = {
          accessKeyId: parsed.accessKeyId,
          secretAccessKey: parsed.secretAccessKey,
        };
        if (parsed.sessionToken) {
          awsCredentials.sessionToken = parsed.sessionToken;
        }
        client = new BedrockClient({
          region: parsed.region || 'us-east-1',
          credentials: awsCredentials,
        });
      } else if (parsed.authType === 'profile') {
        // AWS Profile authentication
        client = new BedrockClient({
          region: parsed.region || 'us-east-1',
          credentials: fromIni({ profile: parsed.profileName || 'default' }),
        });
      } else {
        return { valid: false, error: 'Invalid authentication type' };
      }

      // Test by listing foundation models
      const command = new ListFoundationModelsCommand({});
      await client.send(command);

      console.log('[Bedrock] Validation succeeded');
      return { valid: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Validation failed';
      console.warn('[Bedrock] Validation failed:', message);

      // Provide user-friendly error messages
      if (message.includes('UnrecognizedClientException') || message.includes('InvalidSignatureException')) {
        return { valid: false, error: 'Invalid AWS credentials. Please check your Access Key ID and Secret Access Key.' };
      }
      if (message.includes('AccessDeniedException')) {
        return { valid: false, error: 'Access denied. Ensure your AWS credentials have Bedrock permissions.' };
      }
      if (message.includes('could not be found')) {
        return { valid: false, error: 'AWS profile not found. Check your ~/.aws/credentials file.' };
      }

      return { valid: false, error: message };
    }
  });

  // Bedrock: Save credentials
  handle('bedrock:save', async (_event: IpcMainInvokeEvent, credentials: string) => {
    const parsed = JSON.parse(credentials);

    // Validate structure
    if (parsed.authType === 'accessKeys') {
      if (!parsed.accessKeyId || !parsed.secretAccessKey) {
        throw new Error('Access Key ID and Secret Access Key are required');
      }
    } else if (parsed.authType === 'profile') {
      if (!parsed.profileName) {
        throw new Error('Profile name is required');
      }
    } else {
      throw new Error('Invalid authentication type');
    }

    // Store the credentials
    storeApiKey('bedrock', credentials);

    return {
      id: 'local-bedrock',
      provider: 'bedrock',
      label: parsed.authType === 'accessKeys' ? 'AWS Access Keys' : `AWS Profile: ${parsed.profileName}`,
      keyPrefix: parsed.authType === 'accessKeys' ? `${parsed.accessKeyId.substring(0, 8)}...` : parsed.profileName,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
  });

  // Bedrock: Get credentials
  handle('bedrock:get-credentials', async (_event: IpcMainInvokeEvent) => {
    const stored = getApiKey('bedrock');
    if (!stored) return null;
    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  });

  // API Key: Clear API key
  handle('api-key:clear', async (_event: IpcMainInvokeEvent) => {
    await deleteApiKey('anthropic');
    console.log('[API Key] Key cleared');
  });

  // OpenCode CLI: Check if installed
  handle('opencode:check', async (_event: IpcMainInvokeEvent) => {
    // E2E test bypass: return mock CLI status when E2E skip auth is enabled
    if (isE2ESkipAuthEnabled()) {
      return {
        installed: true,
        version: '1.0.0-test',
        installCommand: 'npm install -g opencode-ai',
      };
    }

    const installed = await isOpenCodeCliInstalled();
    const version = installed ? await getOpenCodeCliVersion() : null;
    return {
      installed,
      version,
      installCommand: 'npm install -g opencode-ai',
    };
  });

  // OpenCode CLI: Get version
  handle('opencode:version', async (_event: IpcMainInvokeEvent) => {
    return getOpenCodeCliVersion();
  });

  // Model: Get selected model
  handle('model:get', async (_event: IpcMainInvokeEvent) => {
    return getSelectedModel();
  });

  // Model: Set selected model
  handle('model:set', async (_event: IpcMainInvokeEvent, model: SelectedModel) => {
    if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string') {
      throw new Error('Invalid model configuration');
    }
    setSelectedModel(model);
  });

  // Ollama: Test connection and get models
  handle('ollama:test-connection', async (_event: IpcMainInvokeEvent, url: string) => {
    const sanitizedUrl = sanitizeString(url, 'ollamaUrl', 256);

    // Validate URL format and protocol
    try {
      const parsed = new URL(sanitizedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: 'Only http and https URLs are allowed' };
      }
    } catch {
      return { success: false, error: 'Invalid URL format' };
    }

    try {
      const response = await fetchWithTimeout(
        `${sanitizedUrl}/api/tags`,
        { method: 'GET' },
        API_KEY_VALIDATION_TIMEOUT_MS
      );

      if (!response.ok) {
        throw new Error(`Ollama returned status ${response.status}`);
      }

      const data = await response.json() as { models?: Array<{ name: string; size: number }> };
      const models: OllamaModel[] = (data.models || []).map((m) => ({
        id: m.name,
        displayName: m.name,
        size: m.size,
      }));

      console.log(`[Ollama] Connection successful, found ${models.length} models`);
      return { success: true, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      console.warn('[Ollama] Connection failed:', message);

      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Connection timed out. Make sure Ollama is running.' };
      }
      return { success: false, error: `Cannot connect to Ollama: ${message}` };
    }
  });

  // Ollama: Get stored config
  handle('ollama:get-config', async (_event: IpcMainInvokeEvent) => {
    return getOllamaConfig();
  });

  // Ollama: Set config
  handle('ollama:set-config', async (_event: IpcMainInvokeEvent, config: OllamaConfig | null) => {
    if (config !== null) {
      if (typeof config.baseUrl !== 'string' || typeof config.enabled !== 'boolean') {
        throw new Error('Invalid Ollama configuration');
      }
      // Validate URL format and protocol
      try {
        const parsed = new URL(config.baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Only http and https URLs are allowed');
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('http')) {
          throw e; // Re-throw our protocol error
        }
        throw new Error('Invalid base URL format');
      }
      // Validate optional lastValidated if present
      if (config.lastValidated !== undefined && typeof config.lastValidated !== 'number') {
        throw new Error('Invalid Ollama configuration');
      }
      // Validate optional models array if present
      if (config.models !== undefined) {
        if (!Array.isArray(config.models)) {
          throw new Error('Invalid Ollama configuration: models must be an array');
        }
        for (const model of config.models) {
          if (typeof model.id !== 'string' || typeof model.displayName !== 'string' || typeof model.size !== 'number') {
            throw new Error('Invalid Ollama configuration: invalid model format');
          }
        }
      }
    }
    setOllamaConfig(config);
    console.log('[Ollama] Config saved:', config);
  });

  // OpenRouter: Fetch available models
  handle('openrouter:fetch-models', async (_event: IpcMainInvokeEvent) => {
    const apiKey = getApiKey('openrouter');
    if (!apiKey) {
      return { success: false, error: 'No OpenRouter API key configured' };
    }

    try {
      const response = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/models',
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        },
        API_KEY_VALIDATION_TIMEOUT_MS
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = (errorData as { error?: { message?: string } })?.error?.message || `API returned status ${response.status}`;
        return { success: false, error: errorMessage };
      }

      const data = await response.json() as { data?: Array<{ id: string; name: string; context_length?: number }> };
      const models = (data.data || []).map((m) => {
        // Extract provider from model ID (e.g., "anthropic/claude-3.5-sonnet" -> "anthropic")
        const provider = m.id.split('/')[0] || 'unknown';
        return {
          id: m.id,
          name: m.name || m.id,
          provider,
          contextLength: m.context_length || 0,
        };
      });

      console.log(`[OpenRouter] Fetched ${models.length} models`);
      return { success: true, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch models';
      console.warn('[OpenRouter] Fetch failed:', message);

      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Request timed out. Check your internet connection.' };
      }
      return { success: false, error: `Failed to fetch models: ${message}` };
    }
  });

  // LiteLLM: Test connection and fetch models
  handle('litellm:test-connection', async (_event: IpcMainInvokeEvent, url: string, apiKey?: string) => {
    const sanitizedUrl = sanitizeString(url, 'litellmUrl', 256);
    const sanitizedApiKey = apiKey ? sanitizeString(apiKey, 'apiKey', 256) : undefined;

    // Validate URL format and protocol
    try {
      const parsed = new URL(sanitizedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: 'Only http and https URLs are allowed' };
      }
    } catch {
      return { success: false, error: 'Invalid URL format' };
    }

    try {
      const headers: Record<string, string> = {};
      if (sanitizedApiKey) {
        headers['Authorization'] = `Bearer ${sanitizedApiKey}`;
      }

      const response = await fetchWithTimeout(
        `${sanitizedUrl}/v1/models`,
        { method: 'GET', headers },
        API_KEY_VALIDATION_TIMEOUT_MS
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = (errorData as { error?: { message?: string } })?.error?.message || `API returned status ${response.status}`;
        return { success: false, error: errorMessage };
      }

      const data = await response.json() as { data?: Array<{ id: string; object: string; created?: number; owned_by?: string }> };
      const models = (data.data || []).map((m) => {
        // Extract provider from model ID (e.g., "openai/gpt-4" -> "openai")
        const provider = m.id.split('/')[0] || m.owned_by || 'unknown';
        return {
          id: m.id,
          name: m.id, // LiteLLM uses id as name
          provider,
          contextLength: 0, // LiteLLM doesn't provide this in /v1/models
        };
      });

      console.log(`[LiteLLM] Connection successful, found ${models.length} models`);
      return { success: true, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      console.warn('[LiteLLM] Connection failed:', message);

      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Connection timed out. Make sure LiteLLM proxy is running.' };
      }
      return { success: false, error: `Cannot connect to LiteLLM: ${message}` };
    }
  });

  // LiteLLM: Fetch models from configured proxy
  handle('litellm:fetch-models', async (_event: IpcMainInvokeEvent) => {
    const config = getLiteLLMConfig();
    if (!config || !config.baseUrl) {
      return { success: false, error: 'No LiteLLM proxy configured' };
    }

    const apiKey = getApiKey('litellm');

    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await fetchWithTimeout(
        `${config.baseUrl}/v1/models`,
        { method: 'GET', headers },
        API_KEY_VALIDATION_TIMEOUT_MS
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = (errorData as { error?: { message?: string } })?.error?.message || `API returned status ${response.status}`;
        return { success: false, error: errorMessage };
      }

      const data = await response.json() as { data?: Array<{ id: string; object: string; created?: number; owned_by?: string }> };
      const models = (data.data || []).map((m) => {
        // Extract provider from model ID (e.g., "anthropic/claude-sonnet" -> "anthropic")
        const parts = m.id.split('/');
        const provider = parts.length > 1 ? parts[0] : (m.owned_by !== 'openai' ? m.owned_by : 'unknown') || 'unknown';

        // Generate display name (e.g., "anthropic/claude-sonnet" -> "Anthropic: Claude Sonnet")
        const modelPart = parts.length > 1 ? parts.slice(1).join('/') : m.id;
        const providerDisplay = provider.charAt(0).toUpperCase() + provider.slice(1);
        const modelDisplay = modelPart
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
        const displayName = parts.length > 1 ? `${providerDisplay}: ${modelDisplay}` : modelDisplay;

        return {
          id: m.id,
          name: displayName,
          provider,
          contextLength: 0,
        };
      });

      console.log(`[LiteLLM] Fetched ${models.length} models`);
      return { success: true, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch models';
      console.warn('[LiteLLM] Fetch failed:', message);

      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Request timed out. Check your LiteLLM proxy.' };
      }
      return { success: false, error: `Failed to fetch models: ${message}` };
    }
  });

  // LiteLLM: Get stored config
  handle('litellm:get-config', async (_event: IpcMainInvokeEvent) => {
    return getLiteLLMConfig();
  });

  // LiteLLM: Set config
  handle('litellm:set-config', async (_event: IpcMainInvokeEvent, config: LiteLLMConfig | null) => {
    if (config !== null) {
      if (typeof config.baseUrl !== 'string' || typeof config.enabled !== 'boolean') {
        throw new Error('Invalid LiteLLM configuration');
      }
      // Validate URL format and protocol
      try {
        const parsed = new URL(config.baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Only http and https URLs are allowed');
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('http')) {
          throw e; // Re-throw our protocol error
        }
        throw new Error('Invalid base URL format');
      }
      // Validate optional lastValidated if present
      if (config.lastValidated !== undefined && typeof config.lastValidated !== 'number') {
        throw new Error('Invalid LiteLLM configuration');
      }
      // Validate optional models array if present
      if (config.models !== undefined) {
        if (!Array.isArray(config.models)) {
          throw new Error('Invalid LiteLLM configuration: models must be an array');
        }
        for (const model of config.models) {
          if (typeof model.id !== 'string' || typeof model.name !== 'string' || typeof model.provider !== 'string') {
            throw new Error('Invalid LiteLLM configuration: invalid model format');
          }
        }
      }
    }
    setLiteLLMConfig(config);
    console.log('[LiteLLM] Config saved:', config);
  });

  // API Keys: Get all API keys (with masked values)
  handle('api-keys:all', async (_event: IpcMainInvokeEvent) => {
    const keys = await getAllApiKeys();
    // Return masked versions for UI
    const masked: Record<string, { exists: boolean; prefix?: string }> = {};
    for (const [provider, key] of Object.entries(keys)) {
      masked[provider] = {
        exists: Boolean(key),
        prefix: key ? key.substring(0, 8) + '...' : undefined,
      };
    }
    return masked;
  });

  // API Keys: Check if any key exists
  handle('api-keys:has-any', async (_event: IpcMainInvokeEvent) => {
    // In E2E mock mode, pretend we have API keys
    if (isMockTaskEventsEnabled()) {
      return true;
    }
    return hasAnyApiKey();
  });

  // Settings: Get debug mode setting
  handle('settings:debug-mode', async (_event: IpcMainInvokeEvent) => {
    return getDebugMode();
  });

  // Settings: Set debug mode setting
  handle('settings:set-debug-mode', async (_event: IpcMainInvokeEvent, enabled: boolean) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Invalid debug mode flag');
    }
    setDebugMode(enabled);
    // Broadcast the change to all renderer windows
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:debug-mode-changed', { enabled });
    }
  });

  // Settings: Get all app settings
  handle('settings:app-settings', async (_event: IpcMainInvokeEvent) => {
    return getAppSettings();
  });

  // Memory: Get MemOS status
  handle('memory:get-config', async (_event: IpcMainInvokeEvent) => {
    const apiKey = getApiKey('memos');
    return {
      hasApiKey: Boolean(apiKey),
      apiKeyPrefix: apiKey ? `${apiKey.substring(0, 8)}...` : undefined,
    };
  });

  // Memory: Set MemOS API key
  handle('memory:set-api-key', async (_event: IpcMainInvokeEvent, key: string) => {
    const sanitizedKey = sanitizeString(key, 'memosApiKey', 512);
    storeApiKey('memos', sanitizedKey);
  });

  // Memory: Clear MemOS API key
  handle('memory:clear-api-key', async (_event: IpcMainInvokeEvent) => {
    deleteApiKey('memos');
  });

  // Onboarding: Get onboarding complete status
  // Also checks for existing task history to handle upgrades from pre-onboarding versions
  handle('onboarding:complete', async (_event: IpcMainInvokeEvent) => {
    // E2E test bypass: skip onboarding when E2E skip auth is enabled
    if (isE2ESkipAuthEnabled()) {
      return true;
    }

    // If onboarding is already marked complete, return true
    if (getOnboardingComplete()) {
      return true;
    }

    // Check if this is an existing user (has task history)
    // If so, mark onboarding as complete and skip the wizard
    const tasks = getTasks();
    if (tasks.length > 0) {
      setOnboardingComplete(true);
      return true;
    }

    return false;
  });

  // Onboarding: Set onboarding complete status
  handle('onboarding:set-complete', async (_event: IpcMainInvokeEvent, complete: boolean) => {
    setOnboardingComplete(complete);
  });

  // Shell: Open URL in external browser
  // Only allows http/https URLs for security
  handle('shell:open-external', async (_event: IpcMainInvokeEvent, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http and https URLs are allowed');
      }
      await shell.openExternal(url);
    } catch (error) {
      console.error('Failed to open external URL:', error);
      throw error;
    }
  });

  // Log event handler - now just returns ok (no external logging)
  handle(
    'log:event',
    async (_event: IpcMainInvokeEvent, _payload: { level?: string; message?: string; context?: Record<string, unknown> }) => {
      // No-op: external logging removed
      return { ok: true };
    }
  );
}

function createTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Extract base64 screenshots from tool output
 * Returns cleaned text (with images replaced by placeholders) and extracted attachments
 */
function extractScreenshots(output: string): {
  cleanedText: string;
  attachments: Array<{ type: 'screenshot' | 'json'; data: string; label?: string }>;
} {
  const attachments: Array<{ type: 'screenshot' | 'json'; data: string; label?: string }> = [];

  // Match data URLs (data:image/png;base64,...)
  const dataUrlRegex = /data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g;
  let match;
  while ((match = dataUrlRegex.exec(output)) !== null) {
    attachments.push({
      type: 'screenshot',
      data: match[0],
      label: 'Browser screenshot',
    });
  }

  // Also check for raw base64 PNG (starts with iVBORw0)
  // This pattern matches PNG base64 that isn't already a data URL
  const rawBase64Regex = /(?<![;,])(?:^|["\s])?(iVBORw0[A-Za-z0-9+/=]{100,})(?:["\s]|$)/g;
  while ((match = rawBase64Regex.exec(output)) !== null) {
    const base64Data = match[1];
    // Wrap in data URL if it's valid base64 PNG
    if (base64Data && base64Data.length > 100) {
      attachments.push({
        type: 'screenshot',
        data: `data:image/png;base64,${base64Data}`,
        label: 'Browser screenshot',
      });
    }
  }

  // Clean the text - replace image data with placeholder
  let cleanedText = output
    .replace(dataUrlRegex, '[Screenshot captured]')
    .replace(rawBase64Regex, '[Screenshot captured]');

  // Also clean up common JSON wrappers around screenshots
  cleanedText = cleanedText
    .replace(/"[Screenshot captured]"/g, '"[Screenshot]"')
    .replace(/\[Screenshot captured\]\[Screenshot captured\]/g, '[Screenshot captured]');

  return { cleanedText, attachments };
}

/**
 * Sanitize tool output to remove technical details that confuse users
 */
function sanitizeToolOutput(text: string, isError: boolean): string {
  let result = text;

  // Strip any remaining ANSI escape codes
  result = result.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  // Also strip any leftover escape sequences that may have been partially matched
  result = result.replace(/\x1B\[2m|\x1B\[22m|\x1B\[0m/g, '');

  // Remove WebSocket URLs
  result = result.replace(/ws:\/\/[^\s\]]+/g, '[connection]');

  // Remove "Call log:" sections and everything after
  result = result.replace(/\s*Call log:[\s\S]*/i, '');

  // Simplify common Playwright/CDP errors for users
  if (isError) {
    // Timeout errors: extract just the timeout duration
    const timeoutMatch = result.match(/timed? ?out after (\d+)ms/i);
    if (timeoutMatch) {
      const seconds = Math.round(parseInt(timeoutMatch[1]) / 1000);
      return `Timed out after ${seconds}s`;
    }

    // "browserType.connectOverCDP: Protocol error (X): Y" → "Y"
    const protocolMatch = result.match(/Protocol error \([^)]+\):\s*(.+)/i);
    if (protocolMatch) {
      result = protocolMatch[1].trim();
    }

    // "Error executing code: X" → just the meaningful part
    result = result.replace(/^Error executing code:\s*/i, '');

    // Clean up "browserType.connectOverCDP:" prefix
    result = result.replace(/browserType\.connectOverCDP:\s*/i, '');

    // Remove stack traces (lines starting with "at ")
    result = result.replace(/\s+at\s+.+/g, '');

    // Remove error class names like "CodeExecutionTimeoutError:"
    result = result.replace(/\w+Error:\s*/g, '');
  }

  return result.trim();
}

function toTaskMessage(message: OpenCodeMessage): TaskMessage | null {
  // OpenCode format: step_start, text, tool_call, tool_use, tool_result, step_finish

  // Handle text content
  if (message.type === 'text') {
    if (message.part.text) {
      return {
        id: createMessageId(),
        type: 'assistant',
        content: message.part.text,
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  }

  // Handle tool calls (legacy format - just shows tool is starting)
  if (message.type === 'tool_call') {
    return {
      id: createMessageId(),
      type: 'tool',
      content: `Using tool: ${message.part.tool}`,
      toolName: message.part.tool,
      toolInput: message.part.input,
      timestamp: new Date().toISOString(),
    };
  }

  // Handle tool_use messages (combined tool call + result)
  if (message.type === 'tool_use') {
    const toolUseMsg = message as import('@accomplish/shared').OpenCodeToolUseMessage;
    const toolName = toolUseMsg.part.tool || 'unknown';
    const toolInput = toolUseMsg.part.state?.input;
    const toolOutput = toolUseMsg.part.state?.output || '';
    const status = toolUseMsg.part.state?.status;

    // Only create message for completed/error status (not pending/running)
    if (status === 'completed' || status === 'error') {
      // Extract screenshots from tool output
      const { cleanedText, attachments } = extractScreenshots(toolOutput);

      // Sanitize output - more aggressive for errors
      const isError = status === 'error';
      const sanitizedText = sanitizeToolOutput(cleanedText, isError);

      // Truncate long outputs for display
      const displayText = sanitizedText.length > 500
        ? sanitizedText.substring(0, 500) + '...'
        : sanitizedText;

      return {
        id: createMessageId(),
        type: 'tool',
        content: displayText || `Tool ${toolName} ${status}`,
        toolName,
        toolInput,
        timestamp: new Date().toISOString(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    }
    return null;
  }

  return null;
}
