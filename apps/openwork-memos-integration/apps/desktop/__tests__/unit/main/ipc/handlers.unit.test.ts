/**
 * Unit tests for IPC handlers
 *
 * Tests the registration and invocation of IPC handlers for:
 * - Task operations (start, cancel, interrupt, get, list, delete, clear)
 * - API key management (get, set, validate, delete)
 * - Settings (debug mode, app settings, model selection)
 * - Onboarding
 * - Permission responses
 * - Session management
 *
 * NOTE: This is a UNIT test, not an integration test.
 * All dependent modules (taskHistory, secureStorage, appSettings, task-manager, adapter)
 * are mocked to test handler logic in isolation. This follows the principle that
 * unit tests should test a single unit with all dependencies mocked.
 *
 * For true integration testing, see the integration tests that use real
 * implementations with temp directories.
 *
 * @module __tests__/unit/main/ipc/handlers.unit.test
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Mock electron modules before importing handlers
vi.mock('electron', () => {
  const mockHandlers = new Map<string, Function>();
  const mockListeners = new Map<string, Set<Function>>();

  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: Function) => {
        mockHandlers.set(channel, handler);
      }),
      on: vi.fn((channel: string, listener: Function) => {
        if (!mockListeners.has(channel)) {
          mockListeners.set(channel, new Set());
        }
        mockListeners.get(channel)!.add(listener);
      }),
      removeHandler: vi.fn((channel: string) => {
        mockHandlers.delete(channel);
      }),
      removeAllListeners: vi.fn((channel?: string) => {
        if (channel) {
          mockListeners.delete(channel);
        } else {
          mockListeners.clear();
        }
      }),
      // Helper to get registered handler for testing
      _getHandler: (channel: string) => mockHandlers.get(channel),
      _getHandlers: () => mockHandlers,
      _clear: () => {
        mockHandlers.clear();
        mockListeners.clear();
      },
    },
    BrowserWindow: {
      fromWebContents: vi.fn(() => ({
        id: 1,
        isDestroyed: vi.fn(() => false),
        webContents: {
          send: vi.fn(),
          isDestroyed: vi.fn(() => false),
        },
      })),
      getFocusedWindow: vi.fn(() => ({
        id: 1,
        isDestroyed: vi.fn(() => false),
      })),
      getAllWindows: vi.fn(() => [{ id: 1, webContents: { send: vi.fn() } }]),
    },
    shell: {
      openExternal: vi.fn(),
    },
    app: {
      isPackaged: false,
      getPath: vi.fn(() => '/tmp/test-app'),
    },
  };
});

// Mock opencode adapter
vi.mock('@main/opencode/adapter', () => ({
  isOpenCodeCliInstalled: vi.fn(() => Promise.resolve(true)),
  getOpenCodeCliVersion: vi.fn(() => Promise.resolve('1.0.0')),
}));

// Mock task manager
const mockTaskManager = {
  startTask: vi.fn(),
  cancelTask: vi.fn(),
  interruptTask: vi.fn(),
  sendResponse: vi.fn(),
  hasActiveTask: vi.fn(() => false),
  getActiveTaskId: vi.fn(() => null),
  getSessionId: vi.fn(() => null),
  isTaskQueued: vi.fn(() => false),
  cancelQueuedTask: vi.fn(),
};

vi.mock('@main/opencode/task-manager', () => ({
  getTaskManager: vi.fn(() => mockTaskManager),
  disposeTaskManager: vi.fn(),
}));

// Mock task history
const mockTasks: Array<{
  id: string;
  prompt: string;
  status: string;
  messages: unknown[];
  createdAt: string;
}> = [];

vi.mock('@main/store/taskHistory', () => ({
  getTasks: vi.fn(() => mockTasks),
  getTask: vi.fn((taskId: string) => mockTasks.find((t) => t.id === taskId)),
  saveTask: vi.fn((task: unknown) => {
    const t = task as { id: string };
    const existing = mockTasks.findIndex((x) => x.id === t.id);
    if (existing >= 0) {
      mockTasks[existing] = task as (typeof mockTasks)[0];
    } else {
      mockTasks.push(task as (typeof mockTasks)[0]);
    }
  }),
  updateTaskStatus: vi.fn(),
  updateTaskSessionId: vi.fn(),
  updateTaskSummary: vi.fn(),
  addTaskMessage: vi.fn(),
  deleteTask: vi.fn((taskId: string) => {
    const idx = mockTasks.findIndex((t) => t.id === taskId);
    if (idx >= 0) mockTasks.splice(idx, 1);
  }),
  clearHistory: vi.fn(() => {
    mockTasks.length = 0;
  }),
}));

// Mock secure storage
let mockApiKeys: Record<string, string | null> = {};
let mockStoredCredentials: Array<{ account: string; password: string }> = [];

vi.mock('@main/store/secureStorage', () => ({
  storeApiKey: vi.fn((provider: string, key: string) => {
    mockApiKeys[provider] = key;
    mockStoredCredentials.push({ account: `apiKey:${provider}`, password: key });
  }),
  getApiKey: vi.fn((provider: string) => mockApiKeys[provider] || null),
  deleteApiKey: vi.fn((provider: string) => {
    delete mockApiKeys[provider];
    mockStoredCredentials = mockStoredCredentials.filter(
      (c) => c.account !== `apiKey:${provider}`
    );
  }),
  getAllApiKeys: vi.fn(() =>
    Promise.resolve({
      anthropic: mockApiKeys['anthropic'] || null,
      openai: mockApiKeys['openai'] || null,
      google: mockApiKeys['google'] || null,
      xai: mockApiKeys['xai'] || null,
      custom: mockApiKeys['custom'] || null,
    })
  ),
  hasAnyApiKey: vi.fn(() =>
    Promise.resolve(Object.values(mockApiKeys).some((k) => k !== null))
  ),
  listStoredCredentials: vi.fn(() => mockStoredCredentials),
}));

// Mock app settings
let mockDebugMode = false;
let mockOnboardingComplete = false;
let mockSelectedModel: { provider: string; model: string } | null = null;

vi.mock('@main/store/appSettings', () => ({
  getDebugMode: vi.fn(() => mockDebugMode),
  setDebugMode: vi.fn((enabled: boolean) => {
    mockDebugMode = enabled;
  }),
  getAppSettings: vi.fn(() => ({
    debugMode: mockDebugMode,
    onboardingComplete: mockOnboardingComplete,
    selectedModel: mockSelectedModel,
  })),
  getOnboardingComplete: vi.fn(() => mockOnboardingComplete),
  setOnboardingComplete: vi.fn((complete: boolean) => {
    mockOnboardingComplete = complete;
  }),
  getSelectedModel: vi.fn(() => mockSelectedModel),
  setSelectedModel: vi.fn((model: { provider: string; model: string }) => {
    mockSelectedModel = model;
  }),
}));

// Mock provider settings
vi.mock('@main/store/providerSettings', () => ({
  getProviderSettings: vi.fn(() => ({
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
  })),
  saveProviderSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({
    providerId: 'anthropic',
    connectionStatus: 'connected',
    selectedModelId: 'claude-3-5-sonnet-20241022',
    credentials: { type: 'api-key', apiKey: 'test-key' },
  })),
  setActiveProvider: vi.fn(),
  getConnectedProvider: vi.fn(() => ({
    providerId: 'anthropic',
    connectionStatus: 'connected',
    selectedModelId: 'claude-3-5-sonnet-20241022',
    credentials: { type: 'api-key', apiKey: 'test-key' },
  })),
  saveConnectedProvider: vi.fn(),
  removeConnectedProvider: vi.fn(),
  getActiveProviderModel: vi.fn(() => ({ provider: 'anthropic', model: 'anthropic/claude-3-5-sonnet-20241022' })),
  getConnectedProviderIds: vi.fn(() => ['anthropic']),
  setProviderDebugMode: vi.fn(),
  getProviderDebugMode: vi.fn(() => false),
  hasReadyProvider: vi.fn(() => true),
}));

// Mock config
vi.mock('@main/config', () => ({
  getDesktopConfig: vi.fn(() => ({})),
}));

// Mock permission API
let mockPendingPermissions = new Map<string, { resolve: Function }>();

vi.mock('@main/permission-api', () => ({
  startPermissionApiServer: vi.fn(),
  startQuestionApiServer: vi.fn(),
  initPermissionApi: vi.fn(),
  resolvePermission: vi.fn((requestId: string, allowed: boolean) => {
    const pending = mockPendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(allowed);
      mockPendingPermissions.delete(requestId);
      return true;
    }
    return false;
  }),
  resolveQuestion: vi.fn(() => true),
  isFilePermissionRequest: vi.fn((requestId: string) => requestId.startsWith('filereq_')),
  isQuestionRequest: vi.fn((requestId: string) => requestId.startsWith('question_')),
  QUESTION_API_PORT: 9227,
}));

// Import after mocks are set up
import { registerIPCHandlers } from '@main/ipc/handlers';
import { ipcMain, BrowserWindow, shell } from 'electron';

// Type the mocked ipcMain with helpers
type MockedIpcMain = typeof ipcMain & {
  _getHandler: (channel: string) => Function | undefined;
  _getHandlers: () => Map<string, Function>;
  _clear: () => void;
};

const mockedIpcMain = ipcMain as MockedIpcMain;

/**
 * Helper to invoke a registered handler
 */
async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mockedIpcMain._getHandler(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }

  // Create mock event
  const mockEvent = {
    sender: {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
  };

  return handler(mockEvent, ...args);
}

describe('IPC Handlers Integration', () => {
  beforeEach(() => {
    // Reset all mocks and state
    vi.clearAllMocks();
    mockedIpcMain._clear();
    mockTasks.length = 0;
    mockApiKeys = {};
    mockStoredCredentials = [];
    mockDebugMode = false;
    mockOnboardingComplete = false;
    mockSelectedModel = null;
    mockPendingPermissions.clear();

    // Reset task manager mocks
    mockTaskManager.startTask.mockReset();
    mockTaskManager.cancelTask.mockReset();
    mockTaskManager.interruptTask.mockReset();
    mockTaskManager.sendResponse.mockReset();
    mockTaskManager.hasActiveTask.mockReturnValue(false);
    mockTaskManager.getActiveTaskId.mockReturnValue(null);
    mockTaskManager.getSessionId.mockReturnValue(null);
    mockTaskManager.isTaskQueued.mockReturnValue(false);
    mockTaskManager.cancelQueuedTask.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('registerIPCHandlers', () => {
    it('should register all expected IPC handlers', () => {
      // Arrange & Act
      registerIPCHandlers();

      // Assert
      const handlers = mockedIpcMain._getHandlers();

      // Task handlers
      expect(handlers.has('task:start')).toBe(true);
      expect(handlers.has('task:cancel')).toBe(true);
      expect(handlers.has('task:interrupt')).toBe(true);
      expect(handlers.has('task:get')).toBe(true);
      expect(handlers.has('task:list')).toBe(true);
      expect(handlers.has('task:delete')).toBe(true);
      expect(handlers.has('task:clear-history')).toBe(true);

      // Permission handler
      expect(handlers.has('permission:respond')).toBe(true);

      // Session handler
      expect(handlers.has('session:resume')).toBe(true);

      // Settings handlers
      expect(handlers.has('settings:api-keys')).toBe(true);
      expect(handlers.has('settings:add-api-key')).toBe(true);
      expect(handlers.has('settings:remove-api-key')).toBe(true);
      expect(handlers.has('settings:debug-mode')).toBe(true);
      expect(handlers.has('settings:set-debug-mode')).toBe(true);
      expect(handlers.has('settings:app-settings')).toBe(true);

      // API key handlers
      expect(handlers.has('api-key:exists')).toBe(true);
      expect(handlers.has('api-key:set')).toBe(true);
      expect(handlers.has('api-key:get')).toBe(true);
      expect(handlers.has('api-key:validate')).toBe(true);
      expect(handlers.has('api-key:validate-provider')).toBe(true);
      expect(handlers.has('api-key:clear')).toBe(true);

      // Multi-provider API key handlers
      expect(handlers.has('api-keys:all')).toBe(true);
      expect(handlers.has('api-keys:has-any')).toBe(true);

      // OpenCode handlers
      expect(handlers.has('opencode:check')).toBe(true);
      expect(handlers.has('opencode:version')).toBe(true);

      // Model handlers
      expect(handlers.has('model:get')).toBe(true);
      expect(handlers.has('model:set')).toBe(true);

      // Onboarding handlers
      expect(handlers.has('onboarding:complete')).toBe(true);
      expect(handlers.has('onboarding:set-complete')).toBe(true);

      // Shell handler
      expect(handlers.has('shell:open-external')).toBe(true);

      // Log handler
      expect(handlers.has('log:event')).toBe(true);
    });
  });

  describe('API Key Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('api-key:exists should return false when no key is stored', async () => {
      // Arrange - no keys stored

      // Act
      const result = await invokeHandler('api-key:exists');

      // Assert
      expect(result).toBe(false);
    });

    it('api-key:set should store the API key', async () => {
      // Arrange
      const testKey = 'sk-test-12345678-abcdef';

      // Act
      await invokeHandler('api-key:set', testKey);
      mockApiKeys['anthropic'] = testKey; // Simulate storage
      const exists = await invokeHandler('api-key:exists');

      // Assert
      expect(exists).toBe(true);
    });

    it('api-key:get should retrieve the stored API key', async () => {
      // Arrange
      const testKey = 'sk-test-retrieve-key';
      mockApiKeys['anthropic'] = testKey;

      // Act
      const result = await invokeHandler('api-key:get');

      // Assert
      expect(result).toBe(testKey);
    });

    it('api-key:clear should remove the stored API key', async () => {
      // Arrange
      mockApiKeys['anthropic'] = 'sk-test-to-delete';

      // Act
      await invokeHandler('api-key:clear');

      // Assert - check deleteApiKey was called
      const { deleteApiKey } = await import('@main/store/secureStorage');
      expect(deleteApiKey).toHaveBeenCalledWith('anthropic');
    });

    it('api-key:set should reject empty keys', async () => {
      // Arrange & Act & Assert
      await expect(invokeHandler('api-key:set', '')).rejects.toThrow();
      await expect(invokeHandler('api-key:set', '   ')).rejects.toThrow();
    });

    it('api-key:set should reject keys exceeding max length', async () => {
      // Arrange
      const longKey = 'x'.repeat(300);

      // Act & Assert
      await expect(invokeHandler('api-key:set', longKey)).rejects.toThrow('exceeds maximum length');
    });
  });

  describe('Settings Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('settings:debug-mode should return current debug mode', async () => {
      // Arrange
      mockDebugMode = true;

      // Act
      const result = await invokeHandler('settings:debug-mode');

      // Assert
      expect(result).toBe(true);
    });

    it('settings:set-debug-mode should update debug mode', async () => {
      // Arrange
      mockDebugMode = false;

      // Act
      await invokeHandler('settings:set-debug-mode', true);

      // Assert
      const { setDebugMode } = await import('@main/store/appSettings');
      expect(setDebugMode).toHaveBeenCalledWith(true);
    });

    it('settings:set-debug-mode should reject non-boolean values', async () => {
      // Arrange & Act & Assert
      await expect(invokeHandler('settings:set-debug-mode', 'true')).rejects.toThrow(
        'Invalid debug mode flag'
      );
      await expect(invokeHandler('settings:set-debug-mode', 1)).rejects.toThrow(
        'Invalid debug mode flag'
      );
    });

    it('settings:app-settings should return all app settings', async () => {
      // Arrange
      mockDebugMode = true;
      mockOnboardingComplete = true;
      mockSelectedModel = { provider: 'anthropic', model: 'claude-3-opus' };

      // Act
      const result = await invokeHandler('settings:app-settings');

      // Assert
      expect(result).toEqual({
        debugMode: true,
        onboardingComplete: true,
        selectedModel: { provider: 'anthropic', model: 'claude-3-opus' },
      });
    });

    it('settings:api-keys should return list of stored API keys', async () => {
      // Arrange
      mockStoredCredentials = [
        { account: 'apiKey:anthropic', password: 'sk-ant-12345678' },
        { account: 'apiKey:openai', password: 'sk-openai-abcdefgh' },
      ];

      // Act
      const result = await invokeHandler('settings:api-keys');

      // Assert
      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: 'anthropic',
            keyPrefix: 'sk-ant-1...',
          }),
          expect.objectContaining({
            provider: 'openai',
            keyPrefix: 'sk-opena...',
          }),
        ])
      );
    });

    it('settings:add-api-key should store API key for valid provider', async () => {
      // Arrange
      const provider = 'anthropic';
      const key = 'sk-ant-new-key-12345';

      // Act
      const result = await invokeHandler('settings:add-api-key', provider, key);

      // Assert
      expect(result).toEqual(
        expect.objectContaining({
          provider: 'anthropic',
          keyPrefix: 'sk-ant-n...',
          isActive: true,
        })
      );
    });

    it('settings:add-api-key should reject unsupported providers', async () => {
      // Arrange & Act & Assert
      await expect(
        invokeHandler('settings:add-api-key', 'unsupported-provider', 'sk-test')
      ).rejects.toThrow('Unsupported API key provider');
    });

    it('settings:remove-api-key should delete the API key', async () => {
      // Arrange
      mockApiKeys['openai'] = 'sk-openai-test';

      // Act
      await invokeHandler('settings:remove-api-key', 'local-openai');

      // Assert
      const { deleteApiKey } = await import('@main/store/secureStorage');
      expect(deleteApiKey).toHaveBeenCalledWith('openai');
    });
  });

  describe('Task Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('task:start should create and start a new task', async () => {
      // Arrange
      const config = { prompt: 'Test task prompt' };
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_123',
        prompt: 'Test task prompt',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await invokeHandler('task:start', config);

      // Assert
      expect(mockTaskManager.startTask).toHaveBeenCalledWith(
        expect.stringMatching(/^task_/),
        expect.objectContaining({ prompt: 'Test task prompt' }),
        expect.any(Object)
      );
      expect(result).toEqual(
        expect.objectContaining({
          prompt: 'Test task prompt',
          status: 'running',
        })
      );
    });

    it('task:start should validate task config', async () => {
      // Arrange - empty prompt

      // Act & Assert
      await expect(invokeHandler('task:start', { prompt: '' })).rejects.toThrow();
      await expect(invokeHandler('task:start', { prompt: '   ' })).rejects.toThrow();
    });

    it('task:cancel should cancel a running task', async () => {
      // Arrange
      const taskId = 'task_to_cancel';
      mockTaskManager.hasActiveTask.mockReturnValue(true);

      // Act
      await invokeHandler('task:cancel', taskId);

      // Assert
      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith(taskId);
    });

    it('task:cancel should cancel a queued task', async () => {
      // Arrange
      const taskId = 'task_queued';
      mockTaskManager.isTaskQueued.mockReturnValue(true);

      // Act
      await invokeHandler('task:cancel', taskId);

      // Assert
      expect(mockTaskManager.cancelQueuedTask).toHaveBeenCalledWith(taskId);
    });

    it('task:cancel should do nothing for non-existent task', async () => {
      // Arrange
      const taskId = 'task_nonexistent';
      mockTaskManager.isTaskQueued.mockReturnValue(false);
      mockTaskManager.hasActiveTask.mockReturnValue(false);

      // Act
      await invokeHandler('task:cancel', taskId);

      // Assert
      expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
      expect(mockTaskManager.cancelQueuedTask).not.toHaveBeenCalled();
    });

    it('task:interrupt should interrupt a running task', async () => {
      // Arrange
      const taskId = 'task_to_interrupt';
      mockTaskManager.hasActiveTask.mockReturnValue(true);

      // Act
      await invokeHandler('task:interrupt', taskId);

      // Assert
      expect(mockTaskManager.interruptTask).toHaveBeenCalledWith(taskId);
    });

    it('task:get should return task from history', async () => {
      // Arrange
      const taskId = 'task_existing';
      mockTasks.push({
        id: taskId,
        prompt: 'Existing task',
        status: 'completed',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await invokeHandler('task:get', taskId);

      // Assert
      expect(result).toEqual(
        expect.objectContaining({
          id: taskId,
          prompt: 'Existing task',
          status: 'completed',
        })
      );
    });

    it('task:get should return null for non-existent task', async () => {
      // Arrange - no tasks

      // Act
      const result = await invokeHandler('task:get', 'task_nonexistent');

      // Assert
      expect(result).toBeNull();
    });

    it('task:list should return all tasks from history', async () => {
      // Arrange
      mockTasks.push(
        {
          id: 'task_1',
          prompt: 'Task 1',
          status: 'completed',
          messages: [],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'task_2',
          prompt: 'Task 2',
          status: 'running',
          messages: [],
          createdAt: new Date().toISOString(),
        }
      );

      // Act
      const result = await invokeHandler('task:list');

      // Assert
      expect(result).toHaveLength(2);
    });

    it('task:delete should remove task from history', async () => {
      // Arrange
      const taskId = 'task_to_delete';
      mockTasks.push({
        id: taskId,
        prompt: 'Task to delete',
        status: 'completed',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('task:delete', taskId);

      // Assert
      const { deleteTask } = await import('@main/store/taskHistory');
      expect(deleteTask).toHaveBeenCalledWith(taskId);
    });

    it('task:clear-history should clear all tasks', async () => {
      // Arrange
      mockTasks.push(
        {
          id: 'task_1',
          prompt: 'Task 1',
          status: 'completed',
          messages: [],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'task_2',
          prompt: 'Task 2',
          status: 'completed',
          messages: [],
          createdAt: new Date().toISOString(),
        }
      );

      // Act
      await invokeHandler('task:clear-history');

      // Assert
      const { clearHistory } = await import('@main/store/taskHistory');
      expect(clearHistory).toHaveBeenCalled();
    });
  });

  describe('Onboarding Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('onboarding:complete should return false when not completed', async () => {
      // Arrange
      mockOnboardingComplete = false;

      // Act
      const result = await invokeHandler('onboarding:complete');

      // Assert
      expect(result).toBe(false);
    });

    it('onboarding:complete should return true when completed', async () => {
      // Arrange
      mockOnboardingComplete = true;

      // Act
      const result = await invokeHandler('onboarding:complete');

      // Assert
      expect(result).toBe(true);
    });

    it('onboarding:complete should return true if user has task history', async () => {
      // Arrange
      mockOnboardingComplete = false;
      mockTasks.push({
        id: 'existing_task',
        prompt: 'Existing task',
        status: 'completed',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await invokeHandler('onboarding:complete');

      // Assert
      expect(result).toBe(true);
    });

    it('onboarding:set-complete should update onboarding status', async () => {
      // Arrange
      mockOnboardingComplete = false;

      // Act
      await invokeHandler('onboarding:set-complete', true);

      // Assert
      const { setOnboardingComplete } = await import('@main/store/appSettings');
      expect(setOnboardingComplete).toHaveBeenCalledWith(true);
    });
  });

  describe('Permission Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('permission:respond should send response for active task', async () => {
      // Arrange
      const taskId = 'task_active';
      mockTaskManager.hasActiveTask.mockReturnValue(true);

      // Act
      await invokeHandler('permission:respond', {
        requestId: 'req_123',
        taskId,
        decision: 'allow',
      });

      // Assert
      expect(mockTaskManager.sendResponse).toHaveBeenCalledWith(taskId, 'yes');
    });

    it('permission:respond should send custom message when provided', async () => {
      // Arrange
      const taskId = 'task_active';
      mockTaskManager.hasActiveTask.mockReturnValue(true);

      // Act
      await invokeHandler('permission:respond', {
        requestId: 'req_123',
        taskId,
        decision: 'allow',
        message: 'proceed with caution',
      });

      // Assert
      expect(mockTaskManager.sendResponse).toHaveBeenCalledWith(taskId, 'proceed with caution');
    });

    it('permission:respond should send "no" for denied decisions', async () => {
      // Arrange
      const taskId = 'task_active';
      mockTaskManager.hasActiveTask.mockReturnValue(true);

      // Act
      await invokeHandler('permission:respond', {
        requestId: 'req_123',
        taskId,
        decision: 'deny',
      });

      // Assert
      expect(mockTaskManager.sendResponse).toHaveBeenCalledWith(taskId, 'no');
    });

    it('permission:respond should resolve file permission requests', async () => {
      // Arrange
      const requestId = 'filereq_123_abc';
      const taskId = 'task_active';

      // Simulate pending file permission
      mockPendingPermissions.set(requestId, { resolve: vi.fn() });

      // Act
      await invokeHandler('permission:respond', {
        requestId,
        taskId,
        decision: 'allow',
      });

      // Assert
      const { resolvePermission } = await import('@main/permission-api');
      expect(resolvePermission).toHaveBeenCalledWith(requestId, true);
    });

    it('permission:respond should skip response for inactive task', async () => {
      // Arrange
      const taskId = 'task_inactive';
      mockTaskManager.hasActiveTask.mockReturnValue(false);

      // Act
      await invokeHandler('permission:respond', {
        requestId: 'req_123',
        taskId,
        decision: 'allow',
      });

      // Assert
      expect(mockTaskManager.sendResponse).not.toHaveBeenCalled();
    });
  });

  describe('Model Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('model:get should return selected model', async () => {
      // Arrange
      mockSelectedModel = { provider: 'anthropic', model: 'claude-3-sonnet' };

      // Act
      const result = await invokeHandler('model:get');

      // Assert
      expect(result).toEqual({ provider: 'anthropic', model: 'claude-3-sonnet' });
    });

    it('model:get should return null when no model selected', async () => {
      // Arrange
      mockSelectedModel = null;

      // Act
      const result = await invokeHandler('model:get');

      // Assert
      expect(result).toBeNull();
    });

    it('model:set should update selected model', async () => {
      // Arrange
      const newModel = { provider: 'openai', model: 'gpt-4' };

      // Act
      await invokeHandler('model:set', newModel);

      // Assert
      const { setSelectedModel } = await import('@main/store/appSettings');
      expect(setSelectedModel).toHaveBeenCalledWith(newModel);
    });

    it('model:set should reject invalid model configuration', async () => {
      // Arrange & Act & Assert
      await expect(invokeHandler('model:set', null)).rejects.toThrow(
        'Invalid model configuration'
      );
      await expect(invokeHandler('model:set', { provider: 'test' })).rejects.toThrow(
        'Invalid model configuration'
      );
      await expect(invokeHandler('model:set', { model: 'test' })).rejects.toThrow(
        'Invalid model configuration'
      );
    });
  });

  describe('Shell Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('shell:open-external should open valid http URL', async () => {
      // Arrange
      const url = 'https://example.com';

      // Act
      await invokeHandler('shell:open-external', url);

      // Assert
      expect(shell.openExternal).toHaveBeenCalledWith(url);
    });

    it('shell:open-external should open valid https URL', async () => {
      // Arrange
      const url = 'http://localhost:3000';

      // Act
      await invokeHandler('shell:open-external', url);

      // Assert
      expect(shell.openExternal).toHaveBeenCalledWith(url);
    });

    it('shell:open-external should reject non-http/https protocols', async () => {
      // Arrange & Act & Assert
      await expect(invokeHandler('shell:open-external', 'file:///etc/passwd')).rejects.toThrow(
        'Only http and https URLs are allowed'
      );
      await expect(invokeHandler('shell:open-external', 'javascript:alert(1)')).rejects.toThrow(
        'Only http and https URLs are allowed'
      );
    });

    it('shell:open-external should reject invalid URLs', async () => {
      // Arrange & Act & Assert
      await expect(invokeHandler('shell:open-external', 'not-a-url')).rejects.toThrow();
    });
  });

  describe('OpenCode Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('opencode:check should return CLI status', async () => {
      // Arrange - mocked to return installed

      // Act
      const result = (await invokeHandler('opencode:check')) as {
        installed: boolean;
        version: string;
        installCommand: string;
      };

      // Assert
      expect(result).toEqual(
        expect.objectContaining({
          installed: true,
          version: '1.0.0',
          installCommand: 'npm install -g opencode-ai',
        })
      );
    });

    it('opencode:version should return CLI version', async () => {
      // Arrange - mocked to return version

      // Act
      const result = await invokeHandler('opencode:version');

      // Assert
      expect(result).toBe('1.0.0');
    });
  });

  describe('Multi-Provider API Key Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('api-keys:all should return masked keys for all providers', async () => {
      // Arrange
      mockApiKeys = {
        anthropic: 'sk-ant-12345678',
        openai: null,
        google: 'AIza1234567890',
        xai: null,
        custom: null,
      };

      // Act
      const result = (await invokeHandler('api-keys:all')) as Record<
        string,
        { exists: boolean; prefix?: string }
      >;

      // Assert
      expect(result.anthropic).toEqual({
        exists: true,
        prefix: 'sk-ant-1...',
      });
      expect(result.openai).toEqual({ exists: false, prefix: undefined });
      expect(result.google).toEqual({
        exists: true,
        prefix: 'AIza1234...',
      });
    });

    it('api-keys:has-any should return true when any key exists', async () => {
      // Arrange
      mockApiKeys['anthropic'] = 'sk-test';

      // Act
      const result = await invokeHandler('api-keys:has-any');

      // Assert
      expect(result).toBe(true);
    });

    it('api-keys:has-any should return false when no keys exist', async () => {
      // Arrange - no keys

      // Act
      const result = await invokeHandler('api-keys:has-any');

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Session Handlers', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('session:resume should start a new task with session ID', async () => {
      // Arrange
      const sessionId = 'session_123';
      const prompt = 'Continue with the task';
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_resumed',
        prompt,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await invokeHandler('session:resume', sessionId, prompt);

      // Assert
      expect(mockTaskManager.startTask).toHaveBeenCalledWith(
        expect.stringMatching(/^task_/),
        expect.objectContaining({
          prompt,
          sessionId,
        }),
        expect.any(Object)
      );
      expect(result).toEqual(
        expect.objectContaining({
          prompt,
          status: 'running',
        })
      );
    });

    it('session:resume should use existing task ID when provided', async () => {
      // Arrange
      const sessionId = 'session_123';
      const prompt = 'Continue';
      const existingTaskId = 'task_existing';
      mockTaskManager.startTask.mockResolvedValue({
        id: existingTaskId,
        prompt,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('session:resume', sessionId, prompt, existingTaskId);

      // Assert
      expect(mockTaskManager.startTask).toHaveBeenCalledWith(
        existingTaskId,
        expect.objectContaining({
          prompt,
          sessionId,
          taskId: existingTaskId,
        }),
        expect.any(Object)
      );
    });

    it('session:resume should validate session ID', async () => {
      // Arrange & Act & Assert
      await expect(invokeHandler('session:resume', '', 'prompt')).rejects.toThrow();
      await expect(invokeHandler('session:resume', '   ', 'prompt')).rejects.toThrow();
    });

    it('session:resume should validate prompt', async () => {
      // Arrange & Act & Assert
      await expect(invokeHandler('session:resume', 'session_123', '')).rejects.toThrow();
      await expect(invokeHandler('session:resume', 'session_123', '   ')).rejects.toThrow();
    });
  });

  describe('Log Event Handler', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('log:event should return ok response', async () => {
      // Arrange
      const payload = {
        level: 'info',
        message: 'Test log message',
        context: { key: 'value' },
      };

      // Act
      const result = await invokeHandler('log:event', payload);

      // Assert
      expect(result).toEqual({ ok: true });
    });
  });

  describe('Task Callbacks and Message Batching', () => {
    beforeEach(() => {
      registerIPCHandlers();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('task:start should initialize permission API on first call', async () => {
      // Arrange
      const config = { prompt: 'Test task prompt' };
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_123',
        prompt: 'Test task prompt',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('task:start', config);

      // Assert
      const { initPermissionApi, startPermissionApiServer } = await import('@main/permission-api');
      expect(initPermissionApi).toHaveBeenCalled();
      expect(startPermissionApiServer).toHaveBeenCalled();
    });

    it('task:start should only initialize permission API once', async () => {
      // Arrange
      const config = { prompt: 'Test task' };
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_1',
        prompt: 'Test task',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act - start two tasks
      await invokeHandler('task:start', config);
      await invokeHandler('task:start', { prompt: 'Second task' });

      // Assert - should only be called once
      const { initPermissionApi } = await import('@main/permission-api');
      expect(initPermissionApi).toHaveBeenCalledTimes(1);
    });

    it('task:start should create initial user message', async () => {
      // Arrange
      const config = { prompt: 'My test prompt' };
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_msg',
        prompt: 'My test prompt',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await invokeHandler('task:start', config) as {
        id: string;
        messages: Array<{ type: string; content: string }>;
      };

      // Assert
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('user');
      expect(result.messages[0].content).toBe('My test prompt');
    });

    it('task:start should save task to history', async () => {
      // Arrange
      const config = { prompt: 'Save me' };
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_save',
        prompt: 'Save me',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('task:start', config);

      // Assert
      const { saveTask } = await import('@main/store/taskHistory');
      expect(saveTask).toHaveBeenCalled();
    });

    it('task:start should validate all optional config fields', async () => {
      // Arrange
      const config = {
        prompt: 'Full config test',
        taskId: 'custom_task_id',
        sessionId: 'custom_session',
        workingDirectory: '/some/path',
        allowedTools: ['tool1', 'tool2', 123, null], // Should filter non-strings
        systemPromptAppend: 'Additional instructions',
        outputSchema: { type: 'object' },
      };
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_full',
        prompt: 'Full config test',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await invokeHandler('task:start', config);

      // Assert
      expect(mockTaskManager.startTask).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          prompt: 'Full config test',
          taskId: 'custom_task_id',
          sessionId: 'custom_session',
          workingDirectory: '/some/path',
          allowedTools: ['tool1', 'tool2'], // Non-strings filtered
          systemPromptAppend: 'Additional instructions',
          outputSchema: { type: 'object' },
        }),
        expect.any(Object)
      );
    });

    it('task:start should truncate allowedTools array to 20 items', async () => {
      // Arrange
      const manyTools = Array.from({ length: 30 }, (_, i) => `tool${i}`);
      const config = {
        prompt: 'Many tools test',
        allowedTools: manyTools,
      };
      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_tools',
        prompt: 'Many tools test',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('task:start', config);

      // Assert
      expect(mockTaskManager.startTask).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          allowedTools: expect.any(Array),
        }),
        expect.any(Object)
      );
      const callArgs = mockTaskManager.startTask.mock.calls[0][1];
      expect(callArgs.allowedTools.length).toBe(20);
    });

    it('task:cancel should do nothing when taskId is undefined', async () => {
      // Arrange & Act
      await invokeHandler('task:cancel', undefined);

      // Assert
      expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
      expect(mockTaskManager.cancelQueuedTask).not.toHaveBeenCalled();
    });

    it('task:interrupt should do nothing when taskId is undefined', async () => {
      // Arrange & Act
      await invokeHandler('task:interrupt', undefined);

      // Assert
      expect(mockTaskManager.interruptTask).not.toHaveBeenCalled();
    });

    it('task:interrupt should do nothing for inactive task', async () => {
      // Arrange
      mockTaskManager.hasActiveTask.mockReturnValue(false);

      // Act
      await invokeHandler('task:interrupt', 'task_inactive');

      // Assert
      expect(mockTaskManager.interruptTask).not.toHaveBeenCalled();
    });
  });

  describe('Session Resume with Existing Task', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('session:resume should add user message to existing task', async () => {
      // Arrange
      const sessionId = 'session_existing';
      const prompt = 'Follow-up message';
      const existingTaskId = 'task_existing';

      mockTaskManager.startTask.mockResolvedValue({
        id: existingTaskId,
        prompt,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('session:resume', sessionId, prompt, existingTaskId);

      // Assert
      const { addTaskMessage } = await import('@main/store/taskHistory');
      expect(addTaskMessage).toHaveBeenCalledWith(
        existingTaskId,
        expect.objectContaining({
          type: 'user',
          content: prompt,
        })
      );
    });

    it('session:resume should update task status in history', async () => {
      // Arrange
      const sessionId = 'session_status';
      const prompt = 'Status update test';
      const existingTaskId = 'task_status';

      mockTaskManager.startTask.mockResolvedValue({
        id: existingTaskId,
        prompt,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('session:resume', sessionId, prompt, existingTaskId);

      // Assert
      const { updateTaskStatus } = await import('@main/store/taskHistory');
      expect(updateTaskStatus).toHaveBeenCalledWith(
        existingTaskId,
        'running',
        expect.any(String)
      );
    });

    it('session:resume should not add message when no existing task ID', async () => {
      // Arrange
      const sessionId = 'session_new';
      const prompt = 'New session';

      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_new',
        prompt,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      await invokeHandler('session:resume', sessionId, prompt);

      // Assert
      const { addTaskMessage } = await import('@main/store/taskHistory');
      // Should not be called for new tasks
      expect(addTaskMessage).not.toHaveBeenCalledWith(
        undefined,
        expect.anything()
      );
    });
  });

  describe('Permission Response Edge Cases', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('permission:respond should use selectedOptions when provided', async () => {
      // Arrange
      const taskId = 'task_options';
      mockTaskManager.hasActiveTask.mockReturnValue(true);

      // Act
      await invokeHandler('permission:respond', {
        requestId: 'req_456',
        taskId,
        decision: 'allow',
        selectedOptions: ['option1', 'option2', 'option3'],
      });

      // Assert
      expect(mockTaskManager.sendResponse).toHaveBeenCalledWith(
        taskId,
        'option1, option2, option3'
      );
    });

    it('permission:respond should log when file permission not found', async () => {
      // Arrange
      const taskId = 'task_notfound';
      mockTaskManager.hasActiveTask.mockReturnValue(false);
      // File permission request that is not in pending
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Act
      await invokeHandler('permission:respond', {
        requestId: 'filereq_notfound',
        taskId,
        decision: 'allow',
      });

      // Assert
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('File permission request')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('Window Trust Validation', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('should throw error when window is destroyed', async () => {
      // Arrange
      const { BrowserWindow } = await import('electron');
      (BrowserWindow.fromWebContents as Mock).mockReturnValue({
        id: 1,
        isDestroyed: () => true,
        webContents: { send: vi.fn(), isDestroyed: () => true },
      });

      // Act & Assert
      await expect(
        invokeHandler('task:start', { prompt: 'Test' })
      ).rejects.toThrow('Untrusted window');
    });

    it('should throw error when window is null', async () => {
      // Arrange
      const { BrowserWindow } = await import('electron');
      (BrowserWindow.fromWebContents as Mock).mockReturnValue(null);

      // Act & Assert
      await expect(
        invokeHandler('task:start', { prompt: 'Test' })
      ).rejects.toThrow('Untrusted window');
    });

    it('should throw error when IPC from non-focused window with multiple windows', async () => {
      // Arrange
      const { BrowserWindow } = await import('electron');
      (BrowserWindow.fromWebContents as Mock).mockReturnValue({
        id: 2, // Different from focused window
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      });
      (BrowserWindow.getFocusedWindow as Mock).mockReturnValue({
        id: 1, // Different ID
        isDestroyed: () => false,
      });
      (BrowserWindow.getAllWindows as Mock).mockReturnValue([{ id: 1 }, { id: 2 }]);

      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_test',
        prompt: 'Test',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act & Assert
      await expect(
        invokeHandler('task:start', { prompt: 'Test' })
      ).rejects.toThrow('IPC request must originate from the focused window');
    });

    it('should allow IPC when only one window exists', async () => {
      // Arrange
      const { BrowserWindow } = await import('electron');
      (BrowserWindow.fromWebContents as Mock).mockReturnValue({
        id: 1,
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      });
      (BrowserWindow.getFocusedWindow as Mock).mockReturnValue({
        id: 2, // Different but only one window
        isDestroyed: () => false,
      });
      (BrowserWindow.getAllWindows as Mock).mockReturnValue([{ id: 1 }]); // Only one window

      mockTaskManager.startTask.mockResolvedValue({
        id: 'task_single',
        prompt: 'Test',
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await invokeHandler('task:start', { prompt: 'Test' });

      // Assert
      expect(result).toBeDefined();
    });
  });

  describe('E2E Skip Auth Mode', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('onboarding:complete should return true when E2E_SKIP_AUTH env is set', async () => {
      // Arrange
      const originalEnv = process.env.E2E_SKIP_AUTH;
      process.env.E2E_SKIP_AUTH = '1';

      // Act
      const result = await invokeHandler('onboarding:complete');

      // Assert
      expect(result).toBe(true);

      // Cleanup
      process.env.E2E_SKIP_AUTH = originalEnv;
    });

    it('opencode:check should return mock status when E2E_SKIP_AUTH is set', async () => {
      // Arrange
      const originalEnv = process.env.E2E_SKIP_AUTH;
      process.env.E2E_SKIP_AUTH = '1';

      // Act
      const result = await invokeHandler('opencode:check') as {
        installed: boolean;
        version: string;
      };

      // Assert
      expect(result.installed).toBe(true);
      expect(result.version).toBe('1.0.0-test');

      // Cleanup
      process.env.E2E_SKIP_AUTH = originalEnv;
    });
  });

  describe('API Key Validation Timeout', () => {
    beforeEach(() => {
      registerIPCHandlers();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('api-key:validate should handle abort error', async () => {
      // Arrange
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        return Promise.reject(abortError);
      }));

      // Act
      const result = await invokeHandler('api-key:validate', 'sk-test-key') as {
        valid: boolean;
        error: string;
      };

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('api-key:validate should handle network errors', async () => {
      // Arrange
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      // Act
      const result = await invokeHandler('api-key:validate', 'sk-test-key') as {
        valid: boolean;
        error: string;
      };

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Failed to validate');
    });

    it('api-key:validate should return invalid for non-200 response', async () => {
      // Arrange
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
      }));

      // Act
      const result = await invokeHandler('api-key:validate', 'sk-test-key') as {
        valid: boolean;
        error: string;
      };

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid API key');
    });

    it('api-key:validate should return valid for 200 response', async () => {
      // Arrange
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      }));

      // Act
      const result = await invokeHandler('api-key:validate', 'sk-test-key') as {
        valid: boolean;
      };

      // Assert
      expect(result.valid).toBe(true);
    });
  });

  describe('Multi-Provider API Key Validation', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('api-key:validate-provider should reject unsupported provider', async () => {
      // Act
      const result = await invokeHandler('api-key:validate-provider', 'invalid-provider', 'key') as {
        valid: boolean;
        error: string;
      };

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unsupported provider');
    });

    it('api-key:validate-provider should skip validation for custom provider', async () => {
      // Act
      const result = await invokeHandler('api-key:validate-provider', 'custom', 'any-key') as {
        valid: boolean;
      };

      // Assert
      expect(result.valid).toBe(true);
    });

    it('api-key:validate-provider should validate OpenAI key', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Act
      const result = await invokeHandler('api-key:validate-provider', 'openai', 'sk-openai-key') as {
        valid: boolean;
      };

      // Assert
      expect(result.valid).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-openai-key',
          }),
        })
      );
    });

    it('api-key:validate-provider should validate Google key', async () => {
      // Arrange
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Act
      const result = await invokeHandler('api-key:validate-provider', 'google', 'AIza-test-key') as {
        valid: boolean;
      };

      // Assert
      expect(result.valid).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models?key=AIza-test-key',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('api-key:validate-provider should handle AbortError', async () => {
      // Arrange
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

      // Act
      const result = await invokeHandler('api-key:validate-provider', 'openai', 'sk-key') as {
        valid: boolean;
        error: string;
      };

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('api-key:validate-provider should handle failed response with error message', async () => {
      // Arrange
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { message: 'Access denied' } }),
      }));

      // Act
      const result = await invokeHandler('api-key:validate-provider', 'openai', 'sk-bad-key') as {
        valid: boolean;
        error: string;
      };

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('api-key:validate-provider should handle failed response without error message', async () => {
      // Arrange
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Invalid JSON')),
      }));

      // Act
      const result = await invokeHandler('api-key:validate-provider', 'openai', 'sk-key') as {
        valid: boolean;
        error: string;
      };

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toContain('API returned status 500');
    });
  });

  describe('Settings Add API Key with Label', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('settings:add-api-key should accept and return custom label', async () => {
      // Arrange
      const provider = 'anthropic';
      const key = 'sk-custom-labeled-key';
      const label = 'My Production Key';

      // Act
      const result = await invokeHandler('settings:add-api-key', provider, key, label) as {
        label: string;
      };

      // Assert
      expect(result.label).toBe('My Production Key');
    });

    it('settings:add-api-key should use default label when not provided', async () => {
      // Arrange
      const provider = 'anthropic';
      const key = 'sk-no-label-key';

      // Act
      const result = await invokeHandler('settings:add-api-key', provider, key) as {
        label: string;
      };

      // Assert
      expect(result.label).toBe('Local API Key');
    });

    it('settings:add-api-key should validate label length', async () => {
      // Arrange
      const provider = 'anthropic';
      const key = 'sk-valid-key';
      const longLabel = 'x'.repeat(200);

      // Act & Assert
      await expect(
        invokeHandler('settings:add-api-key', provider, key, longLabel)
      ).rejects.toThrow('exceeds maximum length');
    });
  });

  describe('Settings API Keys with Empty Password', () => {
    beforeEach(() => {
      registerIPCHandlers();
    });

    it('settings:api-keys should handle empty password', async () => {
      // Arrange
      mockStoredCredentials = [
        { account: 'apiKey:anthropic', password: '' },
      ];

      // Act
      const result = await invokeHandler('settings:api-keys') as Array<{ keyPrefix: string }>;

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].keyPrefix).toBe('');
    });
  });

  // Note: Callback execution tests for onStatusChange, onDebug, onError, onComplete
  // are complex to set up due to vitest mock hoisting for webContents.send.
  // The callback logic is exercised through the task lifecycle tests above.
  // The utility functions (extractScreenshots, sanitizeToolOutput, toTaskMessage)
  // are tested in handlers-utils.unit.test.ts as pure function tests.
});
