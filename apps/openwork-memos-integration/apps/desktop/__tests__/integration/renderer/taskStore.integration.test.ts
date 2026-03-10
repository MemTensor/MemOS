/**
 * Integration tests for taskStore (Zustand)
 * Tests store actions with mocked window.accomplish API
 * @module __tests__/integration/renderer/taskStore.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Task, TaskConfig, TaskStatus, TaskMessage, TaskResult } from '@accomplish/shared';

// Helper to create a mock task
function createMockTask(id: string, prompt: string = 'Test task', status: TaskStatus = 'pending'): Task {
  return {
    id,
    prompt,
    status,
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

// Mock accomplish API
const mockAccomplish = {
  startTask: vi.fn(),
  cancelTask: vi.fn(),
  interruptTask: vi.fn(),
  resumeSession: vi.fn(),
  respondToPermission: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  deleteTask: vi.fn(),
  clearTaskHistory: vi.fn(),
  logEvent: vi.fn().mockResolvedValue(undefined),
  getSelectedModel: vi.fn().mockResolvedValue({ provider: 'anthropic', id: 'claude-3-opus' }),
  getOllamaConfig: vi.fn().mockResolvedValue(null),
  isE2EMode: vi.fn().mockResolvedValue(false),
  getProviderSettings: vi.fn().mockResolvedValue({
    activeProviderId: 'anthropic',
    connectedProviders: {
      anthropic: {
        providerId: 'anthropic',
        connectionStatus: 'connected',
        selectedModelId: 'claude-3-5-sonnet-20241022',
        credentials: { type: 'api-key', apiKey: 'test-key' },
      },
    },
    debugMode: false,
  }),
  // Provider settings methods
  setActiveProvider: vi.fn().mockResolvedValue(undefined),
  setConnectedProvider: vi.fn().mockResolvedValue(undefined),
  removeConnectedProvider: vi.fn().mockResolvedValue(undefined),
  setProviderDebugMode: vi.fn().mockResolvedValue(undefined),
  validateApiKeyForProvider: vi.fn().mockResolvedValue({ valid: true }),
  validateBedrockCredentials: vi.fn().mockResolvedValue({ valid: true }),
  saveBedrockCredentials: vi.fn().mockResolvedValue(undefined),
};

// Mock the accomplish module
vi.mock('@/lib/accomplish', () => ({
  getAccomplish: () => mockAccomplish,
}));

// Mock window.accomplish for global subscriptions
const mockOnTaskProgress = vi.fn();
const mockOnTaskUpdate = vi.fn();

vi.stubGlobal('window', {
  accomplish: {
    onTaskProgress: mockOnTaskProgress,
    onTaskUpdate: mockOnTaskUpdate,
  },
});

describe('taskStore Integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(async () => {
    // Reset store state
    try {
      const { useTaskStore } = await import('@/stores/taskStore');
      useTaskStore.setState({
        currentTask: null,
        isLoading: false,
        error: null,
        tasks: [],
        permissionRequest: null,
        setupProgress: null,
        setupProgressTaskId: null,
        setupDownloadStep: 1,
      });
    } catch {
      // Store may not be loaded
    }
  });

  describe('initial state', () => {
    it('should have null currentTask initially', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask).toBeNull();
    });

    it('should have isLoading as false initially', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      const state = useTaskStore.getState();

      // Assert
      expect(state.isLoading).toBe(false);
    });

    it('should have null error initially', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      const state = useTaskStore.getState();

      // Assert
      expect(state.error).toBeNull();
    });

    it('should have empty tasks array initially', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      const state = useTaskStore.getState();

      // Assert
      expect(state.tasks).toEqual([]);
    });

    it('should have null permissionRequest initially', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      const state = useTaskStore.getState();

      // Assert
      expect(state.permissionRequest).toBeNull();
    });

    it('should have setupDownloadStep as 1 initially', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      const state = useTaskStore.getState();

      // Assert
      expect(state.setupDownloadStep).toBe(1);
    });
  });

  describe('startTask', () => {
    it('should call startTask API and update state on success', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const mockTask = createMockTask('task-123', 'Test prompt', 'running');
      mockAccomplish.startTask.mockResolvedValueOnce(mockTask);

      const config: TaskConfig = { prompt: 'Test prompt' };

      // Act
      const result = await useTaskStore.getState().startTask(config);
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.startTask).toHaveBeenCalledWith(config);
      expect(result).toEqual(mockTask);
      expect(state.currentTask).toEqual(mockTask);
      expect(state.isLoading).toBe(false);
      expect(state.tasks).toContainEqual(mockTask);
    });

    it('should set isLoading to true for queued tasks', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const mockTask = createMockTask('task-123', 'Test prompt', 'queued');
      mockAccomplish.startTask.mockResolvedValueOnce(mockTask);

      // Act
      await useTaskStore.getState().startTask({ prompt: 'Test prompt' });
      const state = useTaskStore.getState();

      // Assert
      expect(state.isLoading).toBe(true);
    });

    it('should set error state on failure', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      mockAccomplish.startTask.mockRejectedValueOnce(new Error('API Error'));

      // Act
      const result = await useTaskStore.getState().startTask({ prompt: 'Test prompt' });
      const state = useTaskStore.getState();

      // Assert
      expect(result).toBeNull();
      expect(state.error).toBe('API Error');
      expect(state.isLoading).toBe(false);
    });

    it('should handle non-Error exceptions gracefully', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      mockAccomplish.startTask.mockRejectedValueOnce('String error');

      // Act
      const result = await useTaskStore.getState().startTask({ prompt: 'Test' });
      const state = useTaskStore.getState();

      // Assert
      expect(result).toBeNull();
      expect(state.error).toBe('Failed to start task');
    });

    it('should add task to tasks list', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const mockTask = createMockTask('task-123', 'Test', 'running');
      mockAccomplish.startTask.mockResolvedValueOnce(mockTask);

      // Set existing tasks
      useTaskStore.setState({ tasks: [createMockTask('existing-task')] });

      // Act
      await useTaskStore.getState().startTask({ prompt: 'Test' });
      const state = useTaskStore.getState();

      // Assert
      expect(state.tasks).toHaveLength(2);
      expect(state.tasks[0].id).toBe('task-123'); // New task should be first
    });

    it('should update existing task if same ID', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const existingTask = createMockTask('task-123', 'Old prompt', 'pending');
      const updatedTask = createMockTask('task-123', 'New prompt', 'running');
      mockAccomplish.startTask.mockResolvedValueOnce(updatedTask);

      useTaskStore.setState({ tasks: [existingTask] });

      // Act
      await useTaskStore.getState().startTask({ prompt: 'New prompt', taskId: 'task-123' });
      const state = useTaskStore.getState();

      // Assert
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].prompt).toBe('New prompt');
    });
  });

  describe('sendFollowUp', () => {
    it('should set error when no active task', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      await useTaskStore.getState().sendFollowUp('Follow up message');
      const state = useTaskStore.getState();

      // Assert
      expect(state.error).toBe('No active task to continue');
    });

    it('should set error when task has no session', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const taskWithoutSession = createMockTask('task-123', 'Test', 'completed');
      useTaskStore.setState({ currentTask: taskWithoutSession });

      // Act
      await useTaskStore.getState().sendFollowUp('Follow up');
      const state = useTaskStore.getState();

      // Assert
      expect(state.error).toBe('No session to continue - please start a new task');
    });

    it('should start fresh task for interrupted task without session', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const interruptedTask: Task = {
        ...createMockTask('task-123', 'Original', 'interrupted'),
      };
      const newTask = createMockTask('task-456', 'Fresh start', 'running');
      mockAccomplish.startTask.mockResolvedValueOnce(newTask);

      useTaskStore.setState({ currentTask: interruptedTask, tasks: [interruptedTask] });

      // Act
      await useTaskStore.getState().sendFollowUp('New message');

      // Assert
      expect(mockAccomplish.startTask).toHaveBeenCalled();
    });

    it('should resume session when task has sessionId', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const taskWithSession: Task = {
        ...createMockTask('task-123', 'Test', 'completed'),
        sessionId: 'session-abc',
      };
      const resumedTask = createMockTask('task-123', 'Test', 'running');
      mockAccomplish.resumeSession.mockResolvedValueOnce(resumedTask);

      useTaskStore.setState({ currentTask: taskWithSession, tasks: [taskWithSession] });

      // Act
      await useTaskStore.getState().sendFollowUp('Continue please');
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.resumeSession).toHaveBeenCalledWith('session-abc', 'Continue please', 'task-123');
      expect(state.currentTask?.status).toBe('running');
    });

    it('should use result.sessionId if available', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const taskWithResultSession: Task = {
        ...createMockTask('task-123', 'Test', 'completed'),
        result: { status: 'success', sessionId: 'result-session-xyz' },
      };
      const resumedTask = createMockTask('task-123', 'Test', 'running');
      mockAccomplish.resumeSession.mockResolvedValueOnce(resumedTask);

      useTaskStore.setState({ currentTask: taskWithResultSession, tasks: [taskWithResultSession] });

      // Act
      await useTaskStore.getState().sendFollowUp('More work');

      // Assert
      expect(mockAccomplish.resumeSession).toHaveBeenCalledWith('result-session-xyz', 'More work', 'task-123');
    });

    it('should add user message optimistically', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const taskWithSession: Task = {
        ...createMockTask('task-123', 'Test', 'completed'),
        sessionId: 'session-abc',
        messages: [],
      };
      mockAccomplish.resumeSession.mockResolvedValueOnce(createMockTask('task-123', 'Test', 'running'));

      useTaskStore.setState({ currentTask: taskWithSession, tasks: [taskWithSession] });

      // Act
      await useTaskStore.getState().sendFollowUp('User follow up');
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.messages).toHaveLength(1);
      expect(state.currentTask?.messages[0].type).toBe('user');
      expect(state.currentTask?.messages[0].content).toBe('User follow up');
    });

    it('should handle resumeSession failure', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const taskWithSession: Task = {
        ...createMockTask('task-123', 'Test', 'completed'),
        sessionId: 'session-abc',
      };
      mockAccomplish.resumeSession.mockRejectedValueOnce(new Error('Resume failed'));

      useTaskStore.setState({ currentTask: taskWithSession, tasks: [taskWithSession] });

      // Act
      await useTaskStore.getState().sendFollowUp('Follow up');
      const state = useTaskStore.getState();

      // Assert
      expect(state.error).toBe('Resume failed');
      expect(state.currentTask?.status).toBe('failed');
      expect(state.isLoading).toBe(false);
    });
  });

  describe('cancelTask', () => {
    it('should call cancelTask API and update status', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const runningTask = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: runningTask, tasks: [runningTask] });
      mockAccomplish.cancelTask.mockResolvedValueOnce(undefined);

      // Act
      await useTaskStore.getState().cancelTask();
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.cancelTask).toHaveBeenCalledWith('task-123');
      expect(state.currentTask?.status).toBe('cancelled');
      expect(state.tasks[0].status).toBe('cancelled');
    });

    it('should do nothing when no current task', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      await useTaskStore.getState().cancelTask();

      // Assert
      expect(mockAccomplish.cancelTask).not.toHaveBeenCalled();
    });
  });

  describe('interruptTask', () => {
    it('should call interruptTask API for running task', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const runningTask = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: runningTask });
      mockAccomplish.interruptTask.mockResolvedValueOnce(undefined);

      // Act
      await useTaskStore.getState().interruptTask();

      // Assert
      expect(mockAccomplish.interruptTask).toHaveBeenCalledWith('task-123');
    });

    it('should not call API for non-running task', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const completedTask = createMockTask('task-123', 'Test', 'completed');
      useTaskStore.setState({ currentTask: completedTask });

      // Act
      await useTaskStore.getState().interruptTask();

      // Assert
      expect(mockAccomplish.interruptTask).not.toHaveBeenCalled();
    });

    it('should not change task status', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const runningTask = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: runningTask });
      mockAccomplish.interruptTask.mockResolvedValueOnce(undefined);

      // Act
      await useTaskStore.getState().interruptTask();
      const state = useTaskStore.getState();

      // Assert - status should remain 'running' (interrupt is handled by event)
      expect(state.currentTask?.status).toBe('running');
    });
  });

  describe('addTaskUpdateBatch', () => {
    it('should add multiple messages in single update', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: task, tasks: [task] });

      const messages = [
        createMockMessage('msg-1', 'assistant', 'First'),
        createMockMessage('msg-2', 'tool', 'Second'),
        createMockMessage('msg-3', 'assistant', 'Third'),
      ];

      // Act
      useTaskStore.getState().addTaskUpdateBatch({ taskId: 'task-123', messages });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.messages).toHaveLength(3);
      expect(state.currentTask?.messages[0].content).toBe('First');
      expect(state.currentTask?.messages[1].content).toBe('Second');
      expect(state.currentTask?.messages[2].content).toBe('Third');
    });

    it('should not update state if task ID does not match', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: task });

      // Act
      useTaskStore.getState().addTaskUpdateBatch({
        taskId: 'different-task',
        messages: [createMockMessage('msg-1')],
      });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.messages).toHaveLength(0);
    });

    it('should not update state if no current task', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');

      // Act
      useTaskStore.getState().addTaskUpdateBatch({
        taskId: 'task-123',
        messages: [createMockMessage('msg-1')],
      });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask).toBeNull();
    });

    it('should append to existing messages', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task: Task = {
        ...createMockTask('task-123', 'Test', 'running'),
        messages: [createMockMessage('existing', 'user', 'Existing')],
      };
      useTaskStore.setState({ currentTask: task });

      // Act
      useTaskStore.getState().addTaskUpdateBatch({
        taskId: 'task-123',
        messages: [createMockMessage('new', 'assistant', 'New')],
      });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.messages).toHaveLength(2);
      expect(state.currentTask?.messages[0].content).toBe('Existing');
      expect(state.currentTask?.messages[1].content).toBe('New');
    });

    it('should set isLoading to false after batch update', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: task, isLoading: true });

      // Act
      useTaskStore.getState().addTaskUpdateBatch({ taskId: 'task-123', messages: [] });
      const state = useTaskStore.getState();

      // Assert
      expect(state.isLoading).toBe(false);
    });
  });

  describe('error state management', () => {
    it('should clear error on successful task start', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      useTaskStore.setState({ error: 'Previous error' });
      mockAccomplish.startTask.mockResolvedValueOnce(createMockTask('task-123'));

      // Act
      await useTaskStore.getState().startTask({ prompt: 'Test' });
      const state = useTaskStore.getState();

      // Assert
      expect(state.error).toBeNull();
    });

    it('should clear error on successful follow up', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const taskWithSession: Task = {
        ...createMockTask('task-123', 'Test', 'completed'),
        sessionId: 'session-abc',
      };
      useTaskStore.setState({ currentTask: taskWithSession, tasks: [taskWithSession], error: 'Previous error' });
      mockAccomplish.resumeSession.mockResolvedValueOnce(createMockTask('task-123', 'Test', 'running'));

      // Act
      await useTaskStore.getState().sendFollowUp('Continue');
      const state = useTaskStore.getState();

      // Assert
      expect(state.error).toBeNull();
    });
  });

  describe('loadTasks', () => {
    it('should load tasks from API', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const mockTasks = [
        createMockTask('task-1'),
        createMockTask('task-2'),
        createMockTask('task-3'),
      ];
      mockAccomplish.listTasks.mockResolvedValueOnce(mockTasks);

      // Act
      await useTaskStore.getState().loadTasks();
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.listTasks).toHaveBeenCalled();
      expect(state.tasks).toEqual(mockTasks);
    });
  });

  describe('loadTaskById', () => {
    it('should load specific task and set as current', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const mockTask = createMockTask('task-123', 'Loaded task');
      mockAccomplish.getTask.mockResolvedValueOnce(mockTask);

      // Act
      await useTaskStore.getState().loadTaskById('task-123');
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.getTask).toHaveBeenCalledWith('task-123');
      expect(state.currentTask).toEqual(mockTask);
      expect(state.error).toBeNull();
    });

    it('should set error when task not found', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      mockAccomplish.getTask.mockResolvedValueOnce(null);

      // Act
      await useTaskStore.getState().loadTaskById('non-existent');
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask).toBeNull();
      expect(state.error).toBe('Task not found');
    });
  });

  describe('deleteTask', () => {
    it('should delete task and remove from list', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const tasks = [
        createMockTask('task-1'),
        createMockTask('task-2'),
        createMockTask('task-3'),
      ];
      useTaskStore.setState({ tasks });
      mockAccomplish.deleteTask.mockResolvedValueOnce(undefined);

      // Act
      await useTaskStore.getState().deleteTask('task-2');
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.deleteTask).toHaveBeenCalledWith('task-2');
      expect(state.tasks).toHaveLength(2);
      expect(state.tasks.find(t => t.id === 'task-2')).toBeUndefined();
    });
  });

  describe('clearHistory', () => {
    it('should clear all tasks', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      useTaskStore.setState({ tasks: [createMockTask('task-1'), createMockTask('task-2')] });
      mockAccomplish.clearTaskHistory.mockResolvedValueOnce(undefined);

      // Act
      await useTaskStore.getState().clearHistory();
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.clearTaskHistory).toHaveBeenCalled();
      expect(state.tasks).toEqual([]);
    });
  });

  describe('reset', () => {
    it('should reset task-related state but preserve tasks list', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const tasks = [createMockTask('task-1'), createMockTask('task-2')];
      useTaskStore.setState({
        currentTask: createMockTask('task-current'),
        isLoading: true,
        error: 'Some error',
        tasks,
        permissionRequest: { id: 'perm-1', taskId: 'task-1', type: 'file', message: 'Allow?' },
        setupProgress: 'Downloading...',
        setupProgressTaskId: 'task-1',
        setupDownloadStep: 2,
      });

      // Act
      useTaskStore.getState().reset();
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.permissionRequest).toBeNull();
      expect(state.setupProgress).toBeNull();
      expect(state.setupProgressTaskId).toBeNull();
      expect(state.setupDownloadStep).toBe(1);
      // Tasks should be preserved
      expect(state.tasks).toEqual(tasks);
    });
  });

  describe('respondToPermission', () => {
    it('should call API and clear permission request', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      useTaskStore.setState({
        permissionRequest: { id: 'perm-1', taskId: 'task-1', type: 'file', message: 'Allow?' },
      });
      mockAccomplish.respondToPermission.mockResolvedValueOnce(undefined);

      const response = { permissionId: 'perm-1', granted: true };

      // Act
      await useTaskStore.getState().respondToPermission(response);
      const state = useTaskStore.getState();

      // Assert
      expect(mockAccomplish.respondToPermission).toHaveBeenCalledWith(response);
      expect(state.permissionRequest).toBeNull();
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task status in tasks list and currentTask', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'queued');
      useTaskStore.setState({ currentTask: task, tasks: [task] });

      // Act
      useTaskStore.getState().updateTaskStatus('task-123', 'running');
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.status).toBe('running');
      expect(state.tasks[0].status).toBe('running');
    });

    it('should only update tasks list when currentTask does not match', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const currentTask = createMockTask('task-current', 'Current', 'running');
      const otherTask = createMockTask('task-other', 'Other', 'queued');
      useTaskStore.setState({ currentTask, tasks: [currentTask, otherTask] });

      // Act
      useTaskStore.getState().updateTaskStatus('task-other', 'running');
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.status).toBe('running'); // Unchanged
      expect(state.tasks.find(t => t.id === 'task-other')?.status).toBe('running');
    });
  });

  describe('addTaskUpdate - complete event', () => {
    it('should set completed status for success result', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: task, tasks: [task] });

      // Act
      useTaskStore.getState().addTaskUpdate({
        type: 'complete',
        taskId: 'task-123',
        result: { status: 'success' },
      });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.status).toBe('completed');
      expect(state.tasks[0].status).toBe('completed');
    });

    it('should set interrupted status for interrupted result', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: task, tasks: [task] });

      // Act
      useTaskStore.getState().addTaskUpdate({
        type: 'complete',
        taskId: 'task-123',
        result: { status: 'interrupted' },
      });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.status).toBe('interrupted');
    });

    it('should set failed status for error result', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: task, tasks: [task] });

      // Act
      useTaskStore.getState().addTaskUpdate({
        type: 'complete',
        taskId: 'task-123',
        result: { status: 'error', error: 'Something went wrong' },
      });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.status).toBe('failed');
    });

    it('should preserve sessionId from result', async () => {
      // Arrange
      const { useTaskStore } = await import('@/stores/taskStore');
      const task = createMockTask('task-123', 'Test', 'running');
      useTaskStore.setState({ currentTask: task, tasks: [task] });

      const result: TaskResult = { status: 'success', sessionId: 'session-from-result' };

      // Act
      useTaskStore.getState().addTaskUpdate({
        type: 'complete',
        taskId: 'task-123',
        result,
      });
      const state = useTaskStore.getState();

      // Assert
      expect(state.currentTask?.sessionId).toBe('session-from-result');
      expect(state.currentTask?.result).toEqual(result);
    });
  });
});
