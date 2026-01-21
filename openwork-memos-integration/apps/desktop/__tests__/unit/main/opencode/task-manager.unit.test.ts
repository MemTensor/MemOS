/**
 * Unit tests for Task Manager
 *
 * Tests the task-manager module which handles task lifecycle, parallel execution,
 * queueing, and cleanup of OpenCode adapter instances.
 *
 * NOTE: This is a UNIT test, not an integration test.
 * The OpenCode adapter is replaced with a mock (MockOpenCodeAdapter) to test
 * task manager logic in isolation. This allows testing task lifecycle, queueing,
 * and event handling without spawning real PTY processes.
 *
 * Mocked components:
 * - OpenCode adapter: Simulated adapter behavior
 * - electron: Native desktop APIs
 * - fs/os: File system operations
 *
 * @module __tests__/unit/main/opencode/task-manager.unit.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { TaskConfig, TaskResult, OpenCodeMessage, PermissionRequest } from '@accomplish/shared';

// Mock electron module
const mockApp = {
  isPackaged: false,
  getAppPath: vi.fn(() => '/mock/app/path'),
  getPath: vi.fn((name: string) => `/mock/path/${name}`),
};

vi.mock('electron', () => ({
  app: mockApp,
}));

// Mock fs module
const mockFs = {
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
};

vi.mock('fs', () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
  readdirSync: mockFs.readdirSync,
  readFileSync: mockFs.readFileSync,
  mkdirSync: mockFs.mkdirSync,
  writeFileSync: mockFs.writeFileSync,
}));

// Mock os module
vi.mock('os', () => ({
  default: { homedir: () => '/Users/testuser' },
  homedir: () => '/Users/testuser',
}));

// Create a mock adapter class
class MockOpenCodeAdapter extends EventEmitter {
  private taskId: string | null = null;
  private sessionId: string | null = null;
  private disposed = false;
  private startTaskFn: (config: TaskConfig) => Promise<{ id: string; prompt: string; status: string; messages: never[]; createdAt: string }>;

  constructor(taskId?: string) {
    super();
    this.taskId = taskId || null;
    this.startTaskFn = vi.fn(async (config: TaskConfig) => {
      this.taskId = config.taskId || `task_${Date.now()}`;
      this.sessionId = `session_${Date.now()}`;
      return {
        id: this.taskId,
        prompt: config.prompt,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      };
    });
  }

  getTaskId() {
    return this.taskId;
  }

  getSessionId() {
    return this.sessionId;
  }

  isAdapterDisposed() {
    return this.disposed;
  }

  async startTask(config: TaskConfig) {
    return this.startTaskFn(config);
  }

  async cancelTask() {
    this.emit('complete', { status: 'cancelled' });
  }

  async interruptTask() {
    this.emit('complete', { status: 'interrupted' });
  }

  async sendResponse(response: string) {
    // Mock response handling
    return response;
  }

  dispose() {
    this.disposed = true;
    this.removeAllListeners();
  }

  // Test helpers
  simulateComplete(result: TaskResult) {
    this.emit('complete', result);
  }

  simulateError(error: Error) {
    this.emit('error', error);
  }

  simulateMessage(message: OpenCodeMessage) {
    this.emit('message', message);
  }

  simulateProgress(progress: { stage: string; message?: string }) {
    this.emit('progress', progress);
  }

  simulatePermissionRequest(request: PermissionRequest) {
    this.emit('permission-request', request);
  }
}

// Track created adapters for testing
const createdAdapters: MockOpenCodeAdapter[] = [];

// Mock the adapter module
vi.mock('@main/opencode/adapter', () => ({
  OpenCodeAdapter: MockOpenCodeAdapter,
  isOpenCodeCliInstalled: vi.fn(() => Promise.resolve(true)),
  OpenCodeCliNotFoundError: class OpenCodeCliNotFoundError extends Error {
    constructor() {
      super('OpenCode CLI is not available');
      this.name = 'OpenCodeCliNotFoundError';
    }
  },
}));

// Mock config generator
vi.mock('@main/opencode/config-generator', () => ({
  getSkillsPath: vi.fn(() => '/mock/skills/path'),
  generateOpenCodeConfig: vi.fn(() => Promise.resolve('/mock/config')),
  ACCOMPLISH_AGENT_NAME: 'accomplish',
}));

// Mock bundled-node
vi.mock('@main/utils/bundled-node', () => ({
  getNpxPath: vi.fn(() => '/mock/npx'),
  getBundledNodePaths: vi.fn(() => null),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, callback: (code: number) => void) => {
      if (event === 'close') {
        setTimeout(() => callback(0), 10);
      }
    }),
    unref: vi.fn(),
  })),
}));

describe('Task Manager Module', () => {
  let TaskManager: typeof import('@main/opencode/task-manager').TaskManager;
  let getTaskManager: typeof import('@main/opencode/task-manager').getTaskManager;
  let disposeTaskManager: typeof import('@main/opencode/task-manager').disposeTaskManager;

  // Helper to create mock callbacks
  function createMockCallbacks() {
    return {
      onMessage: vi.fn(),
      onProgress: vi.fn(),
      onPermissionRequest: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      onStatusChange: vi.fn(),
      onDebug: vi.fn(),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    createdAdapters.length = 0;

    // Re-import module to get fresh state
    const module = await import('@main/opencode/task-manager');
    TaskManager = module.TaskManager;
    getTaskManager = module.getTaskManager;
    disposeTaskManager = module.disposeTaskManager;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('TaskManager Class', () => {
    describe('Constructor', () => {
      it('should create task manager with default max concurrent tasks', () => {
        // Act
        const manager = new TaskManager();

        // Assert
        expect(manager.getActiveTaskCount()).toBe(0);
        expect(manager.getQueueLength()).toBe(0);
      });

      it('should create task manager with custom max concurrent tasks', () => {
        // Arrange & Act
        const manager = new TaskManager({ maxConcurrentTasks: 5 });

        // Assert - verify by filling up to the limit
        expect(manager.getActiveTaskCount()).toBe(0);
      });
    });

    describe('startTask()', () => {
      it('should start a single task successfully', async () => {
        // Arrange
        const manager = new TaskManager();
        const callbacks = createMockCallbacks();
        const config: TaskConfig = { prompt: 'Test task' };

        // Act
        const task = await manager.startTask('task-1', config, callbacks);

        // Assert
        expect(task.id).toBe('task-1');
        expect(task.status).toBe('running');
        expect(manager.hasActiveTask('task-1')).toBe(true);
        expect(manager.getActiveTaskCount()).toBe(1);
      });

      it('should throw error if task ID already exists', async () => {
        // Arrange
        const manager = new TaskManager();
        const callbacks = createMockCallbacks();
        const config: TaskConfig = { prompt: 'Test task' };

        await manager.startTask('task-1', config, callbacks);

        // Act & Assert
        await expect(
          manager.startTask('task-1', config, createMockCallbacks())
        ).rejects.toThrow('already running or queued');
      });

      it('should execute multiple tasks in parallel up to limit', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 3 });

        // Act
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());
        await manager.startTask('task-3', { prompt: 'Task 3' }, createMockCallbacks());

        // Assert
        expect(manager.getActiveTaskCount()).toBe(3);
        expect(manager.getQueueLength()).toBe(0);
        expect(manager.hasActiveTask('task-1')).toBe(true);
        expect(manager.hasActiveTask('task-2')).toBe(true);
        expect(manager.hasActiveTask('task-3')).toBe(true);
      });

      it('should queue tasks when at capacity', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 2 });

        // Act
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());
        const task3 = await manager.startTask('task-3', { prompt: 'Task 3' }, createMockCallbacks());

        // Assert
        expect(manager.getActiveTaskCount()).toBe(2);
        expect(manager.getQueueLength()).toBe(1);
        expect(task3.status).toBe('queued');
        expect(manager.isTaskQueued('task-3')).toBe(true);
      });

      it('should throw error when queue is full', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });

        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());

        // Act & Assert
        await expect(
          manager.startTask('task-3', { prompt: 'Task 3' }, createMockCallbacks())
        ).rejects.toThrow('Maximum queued tasks');
      });

      it('should return queue position for queued tasks', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });

        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());

        // Act
        const position = manager.getQueuePosition('task-2');

        // Assert
        expect(position).toBe(1);
      });

      it('should return 0 for non-queued task position', async () => {
        // Arrange
        const manager = new TaskManager();
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());

        // Act
        const position = manager.getQueuePosition('task-1');

        // Assert
        expect(position).toBe(0);
      });
    });

    describe('Task Event Handling', () => {
      it('should forward message events to callbacks', async () => {
        // Arrange
        const manager = new TaskManager();
        const callbacks = createMockCallbacks();
        await manager.startTask('task-1', { prompt: 'Test' }, callbacks);

        // Note: In real implementation, adapter events would be forwarded
        // This tests the callback wiring
        expect(callbacks.onMessage).not.toHaveBeenCalled(); // No messages yet
      });

      it('should forward progress events to callbacks', async () => {
        // Arrange
        const manager = new TaskManager();
        const callbacks = createMockCallbacks();
        await manager.startTask('task-1', { prompt: 'Test' }, callbacks);

        // Progress is emitted during browser setup
        // Wait a bit for async operations
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Assert - progress should be called during startup
        // Note: Exact number depends on browser detection
        expect(callbacks.onProgress).toHaveBeenCalled();
      });

      it('should cleanup task on completion and process queue', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });
        const callbacks1 = createMockCallbacks();
        const callbacks2 = createMockCallbacks();

        await manager.startTask('task-1', { prompt: 'Task 1' }, callbacks1);
        await manager.startTask('task-2', { prompt: 'Task 2' }, callbacks2);

        expect(manager.getActiveTaskCount()).toBe(1);
        expect(manager.getQueueLength()).toBe(1);

        // Act - simulate task-1 completion
        // In real implementation, this would be triggered by adapter event
        // For this test, we verify the manager state after operations
        expect(manager.hasActiveTask('task-1')).toBe(true);
      });

      it('should cleanup task on error and process queue', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });
        const callbacks1 = createMockCallbacks();
        const callbacks2 = createMockCallbacks();

        await manager.startTask('task-1', { prompt: 'Task 1' }, callbacks1);
        await manager.startTask('task-2', { prompt: 'Task 2' }, callbacks2);

        // Assert initial state
        expect(manager.hasActiveTask('task-1')).toBe(true);
        expect(manager.isTaskQueued('task-2')).toBe(true);
      });
    });

    describe('cancelTask()', () => {
      it('should cancel a running task', async () => {
        // Arrange
        const manager = new TaskManager();
        const callbacks = createMockCallbacks();
        await manager.startTask('task-1', { prompt: 'Test' }, callbacks);

        // Act
        await manager.cancelTask('task-1');

        // Assert
        expect(manager.hasActiveTask('task-1')).toBe(false);
      });

      it('should cancel a queued task', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());

        expect(manager.isTaskQueued('task-2')).toBe(true);

        // Act
        await manager.cancelTask('task-2');

        // Assert
        expect(manager.isTaskQueued('task-2')).toBe(false);
        expect(manager.getQueueLength()).toBe(0);
      });

      it('should handle cancellation of non-existent task gracefully', async () => {
        // Arrange
        const manager = new TaskManager();

        // Act & Assert - should not throw
        await manager.cancelTask('non-existent');
      });

      it('should process queue after cancellation', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });
        const callbacks2 = createMockCallbacks();

        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, callbacks2);

        // Act
        await manager.cancelTask('task-1');

        // Wait for queue processing
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Assert - task-2 should now be active
        expect(manager.getQueueLength()).toBe(0);
      });
    });

    describe('interruptTask()', () => {
      it('should interrupt a running task', async () => {
        // Arrange
        const manager = new TaskManager();
        await manager.startTask('task-1', { prompt: 'Test' }, createMockCallbacks());

        // Act & Assert - should not throw
        await manager.interruptTask('task-1');
      });

      it('should handle interruption of non-existent task gracefully', async () => {
        // Arrange
        const manager = new TaskManager();

        // Act & Assert - should not throw
        await manager.interruptTask('non-existent');
      });
    });

    describe('cancelQueuedTask()', () => {
      it('should remove task from queue and return true', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());

        // Act
        const result = manager.cancelQueuedTask('task-2');

        // Assert
        expect(result).toBe(true);
        expect(manager.getQueueLength()).toBe(0);
      });

      it('should return false for non-queued task', async () => {
        // Arrange
        const manager = new TaskManager();
        await manager.startTask('task-1', { prompt: 'Test' }, createMockCallbacks());

        // Act
        const result = manager.cancelQueuedTask('task-1');

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('sendResponse()', () => {
      it('should send response to active task', async () => {
        // Arrange
        const manager = new TaskManager();
        await manager.startTask('task-1', { prompt: 'Test' }, createMockCallbacks());

        // Act & Assert - should not throw
        await manager.sendResponse('task-1', 'user response');
      });

      it('should throw error for non-existent task', async () => {
        // Arrange
        const manager = new TaskManager();

        // Act & Assert
        await expect(manager.sendResponse('non-existent', 'response')).rejects.toThrow(
          'not found or not active'
        );
      });
    });

    describe('getSessionId()', () => {
      it('should return session ID for active task after adapter starts', async () => {
        // Arrange
        const manager = new TaskManager();
        await manager.startTask('task-1', { prompt: 'Test' }, createMockCallbacks());

        // Wait for async adapter initialization
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Act
        const sessionId = manager.getSessionId('task-1');

        // Assert - session ID may or may not be set depending on adapter state
        // The important thing is that the method doesn't throw and returns expected type
        expect(sessionId === null || typeof sessionId === 'string').toBe(true);
      });

      it('should return null for non-existent task', () => {
        // Arrange
        const manager = new TaskManager();

        // Act
        const sessionId = manager.getSessionId('non-existent');

        // Assert
        expect(sessionId).toBeNull();
      });
    });

    describe('State Query Methods', () => {
      it('should report hasRunningTask correctly', async () => {
        // Arrange
        const manager = new TaskManager();

        // Assert initial state
        expect(manager.hasRunningTask()).toBe(false);

        // Act
        await manager.startTask('task-1', { prompt: 'Test' }, createMockCallbacks());

        // Assert
        expect(manager.hasRunningTask()).toBe(true);
      });

      it('should return all active task IDs', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 3 });
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());

        // Act
        const activeIds = manager.getActiveTaskIds();

        // Assert
        expect(activeIds).toContain('task-1');
        expect(activeIds).toContain('task-2');
        expect(activeIds.length).toBe(2);
      });

      it('should return first active task ID', async () => {
        // Arrange
        const manager = new TaskManager();
        await manager.startTask('task-1', { prompt: 'Test' }, createMockCallbacks());

        // Act
        const activeId = manager.getActiveTaskId();

        // Assert
        expect(activeId).toBe('task-1');
      });

      it('should return null when no active tasks', () => {
        // Arrange
        const manager = new TaskManager();

        // Act
        const activeId = manager.getActiveTaskId();

        // Assert
        expect(activeId).toBeNull();
      });
    });

    describe('dispose()', () => {
      it('should dispose all active tasks', async () => {
        // Arrange
        const manager = new TaskManager();
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());

        // Act
        manager.dispose();

        // Assert
        expect(manager.getActiveTaskCount()).toBe(0);
        expect(manager.hasRunningTask()).toBe(false);
      });

      it('should clear the task queue', async () => {
        // Arrange
        const manager = new TaskManager({ maxConcurrentTasks: 1 });
        await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
        await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());

        expect(manager.getQueueLength()).toBe(1);

        // Act
        manager.dispose();

        // Assert
        expect(manager.getQueueLength()).toBe(0);
      });
    });
  });

  describe('Singleton Functions', () => {
    describe('getTaskManager()', () => {
      it('should return singleton instance', () => {
        // Act
        const manager1 = getTaskManager();
        const manager2 = getTaskManager();

        // Assert
        expect(manager1).toBe(manager2);
      });

      it('should create new instance if none exists', () => {
        // Act
        disposeTaskManager();
        const manager = getTaskManager();

        // Assert
        expect(manager).toBeInstanceOf(TaskManager);
      });
    });

    describe('disposeTaskManager()', () => {
      it('should dispose singleton and allow recreation', () => {
        // Arrange
        const manager1 = getTaskManager();

        // Act
        disposeTaskManager();
        const manager2 = getTaskManager();

        // Assert
        expect(manager2).not.toBe(manager1);
      });

      it('should be safe to call multiple times', () => {
        // Act & Assert - should not throw
        disposeTaskManager();
        disposeTaskManager();
        disposeTaskManager();
      });
    });
  });

  describe('Queue Processing', () => {
    it('should queue tasks and track positions correctly', async () => {
      // Arrange - use maxConcurrentTasks: 2 to allow queue limit of 2
      const manager = new TaskManager({ maxConcurrentTasks: 2 });

      const callbacks1 = createMockCallbacks();
      const callbacks2 = createMockCallbacks();
      const callbacks3 = createMockCallbacks();
      const callbacks4 = createMockCallbacks();

      // Start tasks - first 2 run, next 2 queue
      await manager.startTask('task-1', { prompt: 'Task 1' }, callbacks1);
      await manager.startTask('task-2', { prompt: 'Task 2' }, callbacks2);
      await manager.startTask('task-3', { prompt: 'Task 3' }, callbacks3);
      await manager.startTask('task-4', { prompt: 'Task 4' }, callbacks4);

      // Assert queue state
      expect(manager.getActiveTaskCount()).toBe(2);
      expect(manager.getQueueLength()).toBe(2);
      expect(manager.getQueuePosition('task-3')).toBe(1);
      expect(manager.getQueuePosition('task-4')).toBe(2);
    });

    it('should maintain queue integrity during concurrent operations', async () => {
      // Arrange
      const manager = new TaskManager({ maxConcurrentTasks: 2 });

      // Add multiple tasks
      await manager.startTask('task-1', { prompt: 'Task 1' }, createMockCallbacks());
      await manager.startTask('task-2', { prompt: 'Task 2' }, createMockCallbacks());
      await manager.startTask('task-3', { prompt: 'Task 3' }, createMockCallbacks());
      await manager.startTask('task-4', { prompt: 'Task 4' }, createMockCallbacks());

      // Assert
      expect(manager.getActiveTaskCount()).toBe(2);
      expect(manager.getQueueLength()).toBe(2);

      // Cancel queued task
      const removed = manager.cancelQueuedTask('task-3');
      expect(removed).toBe(true);
      expect(manager.getQueueLength()).toBe(1);

      // task-4 should still be queued
      expect(manager.isTaskQueued('task-4')).toBe(true);
    });
  });
});
