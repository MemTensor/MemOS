/**
 * TaskManager - Manages multiple concurrent OpenCode CLI task executions
 *
 * This class implements a process manager pattern to support true parallel
 * session execution. Each task gets its own OpenCodeAdapter instance with
 * isolated PTY process, state, and event handling.
 */

import { OpenCodeAdapter, isOpenCodeCliInstalled, OpenCodeCliNotFoundError } from './adapter';
import { getSkillsPath } from './config-generator';
import { getNpxPath, getBundledNodePaths } from '../utils/bundled-node';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type {
  TaskConfig,
  Task,
  TaskResult,
  TaskStatus,
  OpenCodeMessage,
  PermissionRequest,
} from '@accomplish/shared';

/**
 * Check if system Chrome is installed
 */
function isSystemChromeInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync('/Applications/Google Chrome.app');
  } else if (process.platform === 'win32') {
    // Check common Windows Chrome locations
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return (
      fs.existsSync(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')) ||
      fs.existsSync(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    );
  }
  // Linux - check common paths
  return fs.existsSync('/usr/bin/google-chrome') || fs.existsSync('/usr/bin/chromium-browser');
}

/**
 * Check if Playwright Chromium is installed
 */
function isPlaywrightInstalled(): boolean {
  const homeDir = os.homedir();
  const possiblePaths = [
    path.join(homeDir, 'Library', 'Caches', 'ms-playwright'), // macOS
    path.join(homeDir, '.cache', 'ms-playwright'), // Linux
  ];

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    possiblePaths.unshift(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  }

  for (const playwrightDir of possiblePaths) {
    if (fs.existsSync(playwrightDir)) {
      try {
        const entries = fs.readdirSync(playwrightDir);
        if (entries.some((entry) => entry.startsWith('chromium'))) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

/**
 * Install Playwright Chromium browser.
 * Returns a promise that resolves when installation is complete.
 * Uses bundled Node.js to ensure it works in packaged app.
 */
async function installPlaywrightChromium(
  onProgress?: (message: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const skillsPath = getSkillsPath();
    const devBrowserDir = path.join(skillsPath, 'dev-browser');

    // Use bundled npx for packaged app compatibility
    const npxPath = getNpxPath();
    const bundledPaths = getBundledNodePaths();

    console.log(`[TaskManager] Installing Playwright Chromium using bundled npx: ${npxPath}`);
    onProgress?.('Downloading browser...');

    // Build environment with bundled node in PATH
    let spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (bundledPaths) {
      const delimiter = process.platform === 'win32' ? ';' : ':';
      spawnEnv.PATH = `${bundledPaths.binDir}${delimiter}${process.env.PATH || ''}`;
    }

    const child = spawn(npxPath, ['playwright', 'install', 'chromium'], {
      cwd: devBrowserDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
    });

    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        console.log(`[Playwright Install] ${line}`);
        // Send progress info: percentage updates and "Downloading X" messages
        if (line.includes('%') || line.toLowerCase().startsWith('downloading')) {
          onProgress?.(line);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        console.log(`[Playwright Install] ${line}`);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('[TaskManager] Playwright Chromium installed successfully');
        onProgress?.('Browser installed successfully!');
        resolve();
      } else {
        reject(new Error(`Playwright install failed with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Ensure the dev-browser server is running.
 * Called before starting tasks to pre-warm the browser.
 *
 * If neither system Chrome nor Playwright is installed, downloads Playwright first.
 *
 * Note: We don't check if server is already running via fetch() because
 * that triggers macOS "Local Network" permission dialog. Instead, we just
 * spawn server.sh which handles the "already running" case internally.
 */
async function ensureDevBrowserServer(
  onProgress?: (progress: { stage: string; message?: string }) => void
): Promise<void> {
  // Check if we have a browser available
  const hasChrome = isSystemChromeInstalled();
  const hasPlaywright = isPlaywrightInstalled();

  console.log(`[TaskManager] Browser check: Chrome=${hasChrome}, Playwright=${hasPlaywright}`);

  // If no browser available, install Playwright first
  if (!hasChrome && !hasPlaywright) {
    console.log('[TaskManager] No browser available, installing Playwright Chromium...');
    onProgress?.({
      stage: 'setup',
      message: 'Chrome not found. Downloading browser (one-time setup, ~2 min)...',
    });

    try {
      await installPlaywrightChromium((msg) => {
        onProgress?.({ stage: 'setup', message: msg });
      });
    } catch (error) {
      console.error('[TaskManager] Failed to install Playwright:', error);
      // Don't throw - let agent handle the failure
    }
  }

  // Now start the server
  try {
    const skillsPath = getSkillsPath();
    const serverScript = path.join(skillsPath, 'dev-browser', 'server.sh');

    // Build environment with bundled Node.js in PATH
    const bundledPaths = getBundledNodePaths();
    let spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (bundledPaths) {
      const delimiter = process.platform === 'win32' ? ';' : ':';
      spawnEnv.PATH = `${bundledPaths.binDir}${delimiter}${process.env.PATH || ''}`;
      spawnEnv.NODE_BIN_PATH = bundledPaths.binDir;
    }

    // Spawn server in background (detached, unref to not block)
    const child = spawn('bash', [serverScript], {
      detached: true,
      stdio: 'ignore',
      cwd: path.join(skillsPath, 'dev-browser'),
      env: spawnEnv,
    });
    child.unref();

    console.log('[TaskManager] Dev-browser server spawn initiated');
  } catch (error) {
    console.error('[TaskManager] Failed to start dev-browser server:', error);
  }
}

/**
 * Callbacks for task events - scoped to a specific task
 */
export interface TaskCallbacks {
  onMessage: (message: OpenCodeMessage) => void;
  onProgress: (progress: { stage: string; message?: string }) => void;
  onPermissionRequest: (request: PermissionRequest) => void;
  onComplete: (result: TaskResult) => void;
  onError: (error: Error) => void;
  onStatusChange?: (status: TaskStatus) => void;
  onDebug?: (log: { type: string; message: string; data?: unknown }) => void;
}

/**
 * Internal representation of a managed task
 */
interface ManagedTask {
  taskId: string;
  adapter: OpenCodeAdapter;
  callbacks: TaskCallbacks;
  cleanup: () => void;
  createdAt: Date;
}

/**
 * Queued task waiting for execution
 */
interface QueuedTask {
  taskId: string;
  config: TaskConfig;
  callbacks: TaskCallbacks;
  createdAt: Date;
}

/**
 * Default maximum number of concurrent tasks
 * Can be configured via constructor
 */
const DEFAULT_MAX_CONCURRENT_TASKS = 10;

/**
 * TaskManager manages OpenCode CLI task executions with parallel execution
 *
 * Multiple tasks can run concurrently up to maxConcurrentTasks.
 * Each task gets its own isolated PTY process and browser pages (prefixed with task ID).
 */
export class TaskManager {
  private activeTasks: Map<string, ManagedTask> = new Map();
  private taskQueue: QueuedTask[] = [];
  private maxConcurrentTasks: number;

  constructor(options?: { maxConcurrentTasks?: number }) {
    this.maxConcurrentTasks = options?.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  }

  /**
   * Start a new task. Multiple tasks can run in parallel up to maxConcurrentTasks.
   * If at capacity, new tasks are queued and start automatically when a task completes.
   */
  async startTask(
    taskId: string,
    config: TaskConfig,
    callbacks: TaskCallbacks
  ): Promise<Task> {
    // Check if CLI is installed
    const cliInstalled = await isOpenCodeCliInstalled();
    if (!cliInstalled) {
      throw new OpenCodeCliNotFoundError();
    }

    // Check if task already exists (either running or queued)
    if (this.activeTasks.has(taskId) || this.taskQueue.some(q => q.taskId === taskId)) {
      throw new Error(`Task ${taskId} is already running or queued`);
    }

    // If at max concurrent tasks, queue this one
    if (this.activeTasks.size >= this.maxConcurrentTasks) {
      console.log(`[TaskManager] At max concurrent tasks (${this.maxConcurrentTasks}). Queueing task ${taskId}`);
      return this.queueTask(taskId, config, callbacks);
    }

    // Execute immediately (parallel execution)
    return this.executeTask(taskId, config, callbacks);
  }

  /**
   * Queue a task for later execution
   */
  private queueTask(
    taskId: string,
    config: TaskConfig,
    callbacks: TaskCallbacks
  ): Task {
    // Check queue limit (allow same number of queued tasks as max concurrent)
    if (this.taskQueue.length >= this.maxConcurrentTasks) {
      throw new Error(
        `Maximum queued tasks (${this.maxConcurrentTasks}) reached. Please wait for tasks to complete.`
      );
    }

    const queuedTask: QueuedTask = {
      taskId,
      config,
      callbacks,
      createdAt: new Date(),
    };

    this.taskQueue.push(queuedTask);
    console.log(`[TaskManager] Task ${taskId} queued. Queue length: ${this.taskQueue.length}`);

    // Return a task object with 'queued' status
    return {
      id: taskId,
      prompt: config.prompt,
      status: 'queued',
      messages: [],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Execute a task immediately (internal)
   */
  private async executeTask(
    taskId: string,
    config: TaskConfig,
    callbacks: TaskCallbacks
  ): Promise<Task> {
    // Create a new adapter instance for this task
    const adapter = new OpenCodeAdapter(taskId);

    // Wire up event listeners
    const onMessage = (message: OpenCodeMessage) => {
      callbacks.onMessage(message);
    };

    const onProgress = (progress: { stage: string; message?: string }) => {
      callbacks.onProgress(progress);
    };

    const onPermissionRequest = (request: PermissionRequest) => {
      callbacks.onPermissionRequest(request);
    };

    const onComplete = (result: TaskResult) => {
      callbacks.onComplete(result);
      // Auto-cleanup on completion and process queue
      this.cleanupTask(taskId);
      this.processQueue();
    };

    const onError = (error: Error) => {
      callbacks.onError(error);
      // Auto-cleanup on error and process queue
      this.cleanupTask(taskId);
      this.processQueue();
    };

    const onDebug = (log: { type: string; message: string; data?: unknown }) => {
      callbacks.onDebug?.(log);
    };

    // Attach listeners
    adapter.on('message', onMessage);
    adapter.on('progress', onProgress);
    adapter.on('permission-request', onPermissionRequest);
    adapter.on('complete', onComplete);
    adapter.on('error', onError);
    adapter.on('debug', onDebug);

    // Create cleanup function
    const cleanup = () => {
      adapter.off('message', onMessage);
      adapter.off('progress', onProgress);
      adapter.off('permission-request', onPermissionRequest);
      adapter.off('complete', onComplete);
      adapter.off('error', onError);
      adapter.off('debug', onDebug);
      adapter.dispose();
    };

    // Register the managed task
    const managedTask: ManagedTask = {
      taskId,
      adapter,
      callbacks,
      cleanup,
      createdAt: new Date(),
    };
    this.activeTasks.set(taskId, managedTask);

    console.log(`[TaskManager] Executing task ${taskId}. Active tasks: ${this.activeTasks.size}`);

    // Create task object immediately so UI can navigate
    const task: Task = {
      id: taskId,
      prompt: config.prompt,
      status: 'running',
      messages: [],
      createdAt: new Date().toISOString(),
    };

    // Start browser setup and agent asynchronously
    // This allows the UI to navigate immediately while setup happens
    (async () => {
      try {
        // Ensure browser is available (may download Playwright if needed)
        await ensureDevBrowserServer(callbacks.onProgress);

        // Now start the agent
        await adapter.startTask({ ...config, taskId });
      } catch (error) {
        // Cleanup on failure and process queue
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        this.cleanupTask(taskId);
        this.processQueue();
      }
    })();

    return task;
  }

  /**
   * Process the queue - start queued tasks if we have capacity
   */
  private async processQueue(): Promise<void> {
    // Start queued tasks while we have capacity
    while (this.taskQueue.length > 0 && this.activeTasks.size < this.maxConcurrentTasks) {
      const nextTask = this.taskQueue.shift()!;
      console.log(`[TaskManager] Processing queue. Starting task ${nextTask.taskId}. Active: ${this.activeTasks.size}, Remaining in queue: ${this.taskQueue.length}`);

      // Notify that task is now running
      nextTask.callbacks.onStatusChange?.('running');

      try {
        await this.executeTask(nextTask.taskId, nextTask.config, nextTask.callbacks);
      } catch (error) {
        console.error(`[TaskManager] Error starting queued task ${nextTask.taskId}:`, error);
        nextTask.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (this.taskQueue.length === 0) {
      console.log('[TaskManager] Queue empty, no more tasks to process');
    }
  }

  /**
   * Cancel a specific task (running or queued)
   */
  async cancelTask(taskId: string): Promise<void> {
    // Check if it's a queued task
    const queueIndex = this.taskQueue.findIndex(q => q.taskId === taskId);
    if (queueIndex !== -1) {
      console.log(`[TaskManager] Cancelling queued task ${taskId}`);
      this.taskQueue.splice(queueIndex, 1);
      return;
    }

    // Otherwise, it's a running task
    const managedTask = this.activeTasks.get(taskId);
    if (!managedTask) {
      console.warn(`[TaskManager] Task ${taskId} not found for cancellation`);
      return;
    }

    console.log(`[TaskManager] Cancelling running task ${taskId}`);

    try {
      await managedTask.adapter.cancelTask();
    } finally {
      this.cleanupTask(taskId);
      // Process queue after cancellation
      this.processQueue();
    }
  }

  /**
   * Interrupt a running task (graceful Ctrl+C)
   * Unlike cancel, this doesn't kill the process - it just interrupts the current operation
   * and allows the agent to wait for the next user input.
   */
  async interruptTask(taskId: string): Promise<void> {
    const managedTask = this.activeTasks.get(taskId);
    if (!managedTask) {
      console.warn(`[TaskManager] Task ${taskId} not found for interruption`);
      return;
    }

    console.log(`[TaskManager] Interrupting task ${taskId}`);
    await managedTask.adapter.interruptTask();
  }

  /**
   * Cancel a queued task and optionally revert to a previous status
   * Used for cancelling follow-ups on completed tasks
   */
  cancelQueuedTask(taskId: string): boolean {
    const queueIndex = this.taskQueue.findIndex(q => q.taskId === taskId);
    if (queueIndex === -1) {
      return false;
    }

    console.log(`[TaskManager] Removing task ${taskId} from queue`);
    this.taskQueue.splice(queueIndex, 1);
    return true;
  }

  /**
   * Check if there are any running tasks
   */
  hasRunningTask(): boolean {
    return this.activeTasks.size > 0;
  }

  /**
   * Check if a specific task is queued
   */
  isTaskQueued(taskId: string): boolean {
    return this.taskQueue.some(q => q.taskId === taskId);
  }

  /**
   * Get queue position (1-based) for a task, or 0 if not queued
   */
  getQueuePosition(taskId: string): number {
    const index = this.taskQueue.findIndex(q => q.taskId === taskId);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * Get the current queue length
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * Send a response to a specific task's PTY (for permissions/questions)
   */
  async sendResponse(taskId: string, response: string): Promise<void> {
    const managedTask = this.activeTasks.get(taskId);
    if (!managedTask) {
      throw new Error(`Task ${taskId} not found or not active`);
    }

    await managedTask.adapter.sendResponse(response);
  }

  /**
   * Get the session ID for a specific task
   */
  getSessionId(taskId: string): string | null {
    const managedTask = this.activeTasks.get(taskId);
    return managedTask?.adapter.getSessionId() ?? null;
  }

  /**
   * Check if a task is active
   */
  hasActiveTask(taskId: string): boolean {
    return this.activeTasks.has(taskId);
  }

  /**
   * Get the number of active tasks
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * Get all active task IDs
   */
  getActiveTaskIds(): string[] {
    return Array.from(this.activeTasks.keys());
  }

  /**
   * Get the currently running task ID (not queued)
   * Returns the first active task if multiple are running
   */
  getActiveTaskId(): string | null {
    const firstActive = this.activeTasks.keys().next();
    return firstActive.done ? null : firstActive.value;
  }

  /**
   * Cleanup a specific task (internal)
   */
  private cleanupTask(taskId: string): void {
    const managedTask = this.activeTasks.get(taskId);
    if (managedTask) {
      console.log(`[TaskManager] Cleaning up task ${taskId}`);
      managedTask.cleanup();
      this.activeTasks.delete(taskId);
      console.log(`[TaskManager] Task ${taskId} cleaned up. Active tasks: ${this.activeTasks.size}`);
    }
  }

  /**
   * Dispose all tasks and cleanup resources
   * Called on app quit
   */
  dispose(): void {
    console.log(`[TaskManager] Disposing all tasks (${this.activeTasks.size} active, ${this.taskQueue.length} queued)`);

    // Clear the queue
    this.taskQueue = [];

    for (const [taskId, managedTask] of this.activeTasks) {
      try {
        managedTask.cleanup();
      } catch (error) {
        console.error(`[TaskManager] Error cleaning up task ${taskId}:`, error);
      }
    }

    this.activeTasks.clear();
    console.log('[TaskManager] All tasks disposed');
  }
}

// Singleton TaskManager instance for the application
let taskManagerInstance: TaskManager | null = null;

/**
 * Get the global TaskManager instance
 */
export function getTaskManager(): TaskManager {
  if (!taskManagerInstance) {
    taskManagerInstance = new TaskManager();
  }
  return taskManagerInstance;
}

/**
 * Dispose the global TaskManager instance
 * Called on app quit
 */
export function disposeTaskManager(): void {
  if (taskManagerInstance) {
    taskManagerInstance.dispose();
    taskManagerInstance = null;
  }
}
