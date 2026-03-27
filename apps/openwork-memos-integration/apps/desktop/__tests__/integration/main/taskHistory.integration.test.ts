/**
 * Integration tests for taskHistory store
 * Tests real electron-store interactions with task persistence
 * @module __tests__/integration/main/taskHistory.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Task, TaskMessage } from '@accomplish/shared';

// Create a unique temp directory for each test run
let tempDir: string;
let originalCwd: string;

// Use a factory function that closes over tempDir
const getTempDir = () => tempDir;

// Mock electron module to control userData path
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return getTempDir();
      }
      return `/mock/path/${name}`;
    },
    getVersion: () => '0.1.0',
    getName: () => 'Accomplish',
    isPackaged: false,
  },
}));

// Helper to create a mock task
function createMockTask(id: string, prompt: string = 'Test task'): Task {
  return {
    id,
    prompt,
    status: 'pending',
    messages: [],
    createdAt: new Date().toISOString(),
  };
}

// Helper to create a mock message
function createMockMessage(
  id: string,
  type: 'assistant' | 'user' | 'tool' | 'system' = 'assistant',
  content: string = 'Test message'
): TaskMessage {
  return {
    id,
    type,
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('taskHistory Integration', () => {
  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskHistory-test-'));
    originalCwd = process.cwd();

    // Reset module cache to get fresh electron-store instances
    vi.resetModules();
  });

  afterEach(async () => {
    // Flush any pending writes and clear timeouts
    try {
      const { flushPendingTasks, clearTaskHistoryStore } = await import('@main/store/taskHistory');
      flushPendingTasks();
      clearTaskHistoryStore();
    } catch {
      // Module may not be loaded
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    process.chdir(originalCwd);
  });

  describe('saveTask and getTask', () => {
    it('should save and retrieve a task by ID', async () => {
      // Arrange
      const { saveTask, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      const task = createMockTask('task-1', 'Save and retrieve test');

      // Act
      saveTask(task);
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result).toBeDefined();
      expect(result?.id).toBe('task-1');
      expect(result?.prompt).toBe('Save and retrieve test');
      expect(result?.status).toBe('pending');
    });

    it('should return undefined for non-existent task', async () => {
      // Arrange
      const { getTask } = await import('@main/store/taskHistory');

      // Act
      const result = getTask('non-existent');

      // Assert
      expect(result).toBeUndefined();
    });

    it('should update existing task when saving with same ID', async () => {
      // Arrange
      const { saveTask, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      const task1 = createMockTask('task-1', 'Original prompt');
      const task2 = { ...createMockTask('task-1', 'Updated prompt'), status: 'running' as const };

      // Act
      saveTask(task1);
      flushPendingTasks();
      saveTask(task2);
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.prompt).toBe('Updated prompt');
      expect(result?.status).toBe('running');
    });

    it('should preserve task messages when saving', async () => {
      // Arrange
      const { saveTask, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      const task: Task = {
        ...createMockTask('task-1'),
        messages: [
          createMockMessage('msg-1', 'user', 'Hello'),
          createMockMessage('msg-2', 'assistant', 'Hi there'),
        ],
      };

      // Act
      saveTask(task);
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.messages).toHaveLength(2);
      expect(result?.messages[0].content).toBe('Hello');
      expect(result?.messages[1].content).toBe('Hi there');
    });

    it('should preserve sessionId when saving', async () => {
      // Arrange
      const { saveTask, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      const task: Task = {
        ...createMockTask('task-1'),
        sessionId: 'session-abc-123',
      };

      // Act
      saveTask(task);
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.sessionId).toBe('session-abc-123');
    });
  });

  describe('getTasks', () => {
    it('should return empty array on fresh store', async () => {
      // Arrange
      const { getTasks } = await import('@main/store/taskHistory');

      // Act
      const result = getTasks();

      // Assert
      expect(result).toEqual([]);
    });

    it('should return all saved tasks', async () => {
      // Arrange
      const { saveTask, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1', 'Task 1'));
      saveTask(createMockTask('task-2', 'Task 2'));
      saveTask(createMockTask('task-3', 'Task 3'));
      flushPendingTasks();

      // Act
      const result = getTasks();

      // Assert
      expect(result).toHaveLength(3);
    });

    it('should return tasks in reverse chronological order (newest first)', async () => {
      // Arrange
      const { saveTask, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1', 'First'));
      saveTask(createMockTask('task-2', 'Second'));
      saveTask(createMockTask('task-3', 'Third'));
      flushPendingTasks();

      // Act
      const result = getTasks();

      // Assert - newest should be first (tasks are unshifted)
      expect(result[0].id).toBe('task-3');
      expect(result[1].id).toBe('task-2');
      expect(result[2].id).toBe('task-1');
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task status without affecting other fields', async () => {
      // Arrange
      const { saveTask, updateTaskStatus, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      const task: Task = {
        ...createMockTask('task-1', 'Status update test'),
        messages: [createMockMessage('msg-1')],
        sessionId: 'session-123',
      };
      saveTask(task);
      flushPendingTasks();

      // Act
      updateTaskStatus('task-1', 'completed');
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.status).toBe('completed');
      expect(result?.prompt).toBe('Status update test');
      expect(result?.messages).toHaveLength(1);
      expect(result?.sessionId).toBe('session-123');
    });

    it('should set completedAt when provided', async () => {
      // Arrange
      const { saveTask, updateTaskStatus, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      flushPendingTasks();
      const completedAt = new Date().toISOString();

      // Act
      updateTaskStatus('task-1', 'completed', completedAt);
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.status).toBe('completed');
      expect(result?.completedAt).toBe(completedAt);
    });

    it('should not modify non-existent task', async () => {
      // Arrange
      const { updateTaskStatus, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');

      // Act
      updateTaskStatus('non-existent', 'completed');
      flushPendingTasks();
      const result = getTasks();

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should transition through various statuses correctly', async () => {
      // Arrange
      const { saveTask, updateTaskStatus, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      flushPendingTasks();

      // Act & Assert
      updateTaskStatus('task-1', 'running');
      flushPendingTasks();
      expect(getTask('task-1')?.status).toBe('running');

      updateTaskStatus('task-1', 'waiting_permission');
      flushPendingTasks();
      expect(getTask('task-1')?.status).toBe('waiting_permission');

      updateTaskStatus('task-1', 'running');
      flushPendingTasks();
      expect(getTask('task-1')?.status).toBe('running');

      updateTaskStatus('task-1', 'completed');
      flushPendingTasks();
      expect(getTask('task-1')?.status).toBe('completed');
    });
  });

  describe('addTaskMessage', () => {
    it('should append message to task', async () => {
      // Arrange
      const { saveTask, addTaskMessage, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      flushPendingTasks();
      const message = createMockMessage('msg-1', 'assistant', 'Hello there');

      // Act
      addTaskMessage('task-1', message);
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.messages).toHaveLength(1);
      expect(result?.messages[0].content).toBe('Hello there');
    });

    it('should append multiple messages in order', async () => {
      // Arrange
      const { saveTask, addTaskMessage, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      flushPendingTasks();

      // Act
      addTaskMessage('task-1', createMockMessage('msg-1', 'user', 'First'));
      addTaskMessage('task-1', createMockMessage('msg-2', 'assistant', 'Second'));
      addTaskMessage('task-1', createMockMessage('msg-3', 'tool', 'Third'));
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.messages).toHaveLength(3);
      expect(result?.messages[0].content).toBe('First');
      expect(result?.messages[1].content).toBe('Second');
      expect(result?.messages[2].content).toBe('Third');
    });

    it('should not modify non-existent task', async () => {
      // Arrange
      const { addTaskMessage, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');

      // Act
      addTaskMessage('non-existent', createMockMessage('msg-1'));
      flushPendingTasks();
      const result = getTasks();

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should preserve existing messages when adding new ones', async () => {
      // Arrange
      const { saveTask, addTaskMessage, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      const task: Task = {
        ...createMockTask('task-1'),
        messages: [createMockMessage('msg-1', 'user', 'Existing')],
      };
      saveTask(task);
      flushPendingTasks();

      // Act
      addTaskMessage('task-1', createMockMessage('msg-2', 'assistant', 'New'));
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.messages).toHaveLength(2);
      expect(result?.messages[0].content).toBe('Existing');
      expect(result?.messages[1].content).toBe('New');
    });
  });

  describe('deleteTask', () => {
    it('should remove only the target task', async () => {
      // Arrange
      const { saveTask, deleteTask, getTasks, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1', 'Keep this'));
      saveTask(createMockTask('task-2', 'Delete this'));
      saveTask(createMockTask('task-3', 'Keep this too'));
      flushPendingTasks();

      // Act
      deleteTask('task-2');
      flushPendingTasks();

      // Assert
      expect(getTasks()).toHaveLength(2);
      expect(getTask('task-1')).toBeDefined();
      expect(getTask('task-2')).toBeUndefined();
      expect(getTask('task-3')).toBeDefined();
    });

    it('should handle deleting non-existent task gracefully', async () => {
      // Arrange
      const { saveTask, deleteTask, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      flushPendingTasks();

      // Act
      deleteTask('non-existent');
      flushPendingTasks();

      // Assert
      expect(getTasks()).toHaveLength(1);
    });

    it('should allow deleting all tasks one by one', async () => {
      // Arrange
      const { saveTask, deleteTask, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      saveTask(createMockTask('task-2'));
      flushPendingTasks();

      // Act
      deleteTask('task-1');
      deleteTask('task-2');
      flushPendingTasks();

      // Assert
      expect(getTasks()).toHaveLength(0);
    });
  });

  describe('clearHistory', () => {
    it('should remove all tasks', async () => {
      // Arrange
      const { saveTask, clearHistory, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      saveTask(createMockTask('task-2'));
      saveTask(createMockTask('task-3'));
      flushPendingTasks();

      // Act
      clearHistory();
      flushPendingTasks();

      // Assert
      expect(getTasks()).toHaveLength(0);
    });

    it('should allow saving new tasks after clear', async () => {
      // Arrange
      const { saveTask, clearHistory, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      flushPendingTasks();
      clearHistory();
      flushPendingTasks();

      // Act
      saveTask(createMockTask('task-new'));
      flushPendingTasks();

      // Assert
      expect(getTasks()).toHaveLength(1);
      expect(getTasks()[0].id).toBe('task-new');
    });
  });

  describe('setMaxHistoryItems', () => {
    it('should enforce history limit when saving new tasks', async () => {
      // Arrange
      const { saveTask, setMaxHistoryItems, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      setMaxHistoryItems(3);

      // Act - save more than the limit
      saveTask(createMockTask('task-1'));
      saveTask(createMockTask('task-2'));
      saveTask(createMockTask('task-3'));
      saveTask(createMockTask('task-4'));
      saveTask(createMockTask('task-5'));
      flushPendingTasks();

      // Assert - should only keep 3 most recent
      const tasks = getTasks();
      expect(tasks).toHaveLength(3);
      expect(tasks[0].id).toBe('task-5');
      expect(tasks[1].id).toBe('task-4');
      expect(tasks[2].id).toBe('task-3');
    });

    it('should trim existing history when limit is reduced', async () => {
      // Arrange
      const { saveTask, setMaxHistoryItems, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      saveTask(createMockTask('task-2'));
      saveTask(createMockTask('task-3'));
      saveTask(createMockTask('task-4'));
      saveTask(createMockTask('task-5'));
      flushPendingTasks();

      // Act - reduce limit
      setMaxHistoryItems(2);
      flushPendingTasks();

      // Assert
      const tasks = getTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe('task-5');
      expect(tasks[1].id).toBe('task-4');
    });

    it('should not affect history when limit is increased', async () => {
      // Arrange
      const { saveTask, setMaxHistoryItems, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      setMaxHistoryItems(3);
      saveTask(createMockTask('task-1'));
      saveTask(createMockTask('task-2'));
      saveTask(createMockTask('task-3'));
      flushPendingTasks();

      // Act
      setMaxHistoryItems(10);
      flushPendingTasks();

      // Assert
      expect(getTasks()).toHaveLength(3);
    });
  });

  describe('debounced flush behavior', () => {
    it('should batch rapid updates into single write', async () => {
      // Arrange
      const { saveTask, addTaskMessage, flushPendingTasks, getTask } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));

      // Act - rapid updates without flush
      addTaskMessage('task-1', createMockMessage('msg-1'));
      addTaskMessage('task-1', createMockMessage('msg-2'));
      addTaskMessage('task-1', createMockMessage('msg-3'));

      // Force flush
      flushPendingTasks();

      // Assert
      const task = getTask('task-1');
      expect(task?.messages).toHaveLength(3);
    });

    it('should flush pending tasks when explicitly called', async () => {
      // Arrange
      const { saveTask, flushPendingTasks, getTasks } = await import('@main/store/taskHistory');

      // Act - save without waiting for debounce
      saveTask(createMockTask('task-1'));
      flushPendingTasks();

      // Assert - task should be persisted immediately
      const tasks = getTasks();
      expect(tasks).toHaveLength(1);
    });

    it('should handle interleaved saves and reads correctly', async () => {
      // Arrange
      const { saveTask, getTask, flushPendingTasks } = await import('@main/store/taskHistory');

      // Act
      saveTask(createMockTask('task-1', 'First'));
      const afterFirst = getTask('task-1');

      saveTask(createMockTask('task-2', 'Second'));
      const afterSecond = getTask('task-2');

      flushPendingTasks();

      // Assert - both should be readable even before flush
      expect(afterFirst?.prompt).toBe('First');
      expect(afterSecond?.prompt).toBe('Second');
    });
  });

  describe('updateTaskSessionId', () => {
    it('should update session ID for existing task', async () => {
      // Arrange
      const { saveTask, updateTaskSessionId, getTask, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      flushPendingTasks();

      // Act
      updateTaskSessionId('task-1', 'new-session-xyz');
      flushPendingTasks();
      const result = getTask('task-1');

      // Assert
      expect(result?.sessionId).toBe('new-session-xyz');
    });

    it('should not modify non-existent task', async () => {
      // Arrange
      const { updateTaskSessionId, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');

      // Act
      updateTaskSessionId('non-existent', 'session-123');
      flushPendingTasks();

      // Assert
      expect(getTasks()).toHaveLength(0);
    });
  });

  describe('clearTaskHistoryStore', () => {
    it('should reset store to defaults', async () => {
      // Arrange
      const { saveTask, clearTaskHistoryStore, getTasks, flushPendingTasks } = await import('@main/store/taskHistory');
      saveTask(createMockTask('task-1'));
      saveTask(createMockTask('task-2'));
      flushPendingTasks();

      // Act
      clearTaskHistoryStore();

      // Assert
      expect(getTasks()).toHaveLength(0);
    });

    it('should clear pending writes without persisting them', async () => {
      // Arrange
      const { saveTask, clearTaskHistoryStore, getTasks } = await import('@main/store/taskHistory');

      // Act - save without flush, then clear
      saveTask(createMockTask('task-1'));
      clearTaskHistoryStore();

      // Assert - pending task should not be persisted
      expect(getTasks()).toHaveLength(0);
    });
  });
});
