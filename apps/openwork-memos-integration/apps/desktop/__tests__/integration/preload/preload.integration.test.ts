/**
 * Integration tests for Preload script
 *
 * Tests the REAL preload script by:
 * 1. Mocking electron APIs (external dependency)
 * 2. Importing the real preload module (triggers contextBridge.exposeInMainWorld)
 * 3. Verifying the exposed API calls the correct IPC channels
 *
 * This is a proper integration test - only external dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pkg from '../../../package.json';

// Create mock functions for electron
const mockExposeInMainWorld = vi.fn();
const mockInvoke = vi.fn(() => Promise.resolve(undefined));
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

// Mock electron module before importing preload
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

// Store captured APIs from exposeInMainWorld calls
let capturedAccomplishAPI: Record<string, unknown> = {};
let capturedAccomplishShell: Record<string, unknown> = {};

describe('Preload Script Integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedAccomplishAPI = {};
    capturedAccomplishShell = {};

    // Capture what the real preload exposes
    mockExposeInMainWorld.mockImplementation((name: string, api: unknown) => {
      if (name === 'accomplish') {
        capturedAccomplishAPI = api as Record<string, unknown>;
      } else if (name === 'accomplishShell') {
        capturedAccomplishShell = api as Record<string, unknown>;
      }
    });

    // Reset module cache and import the REAL preload module
    vi.resetModules();
    await import('../../../src/preload/index');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('API Exposure', () => {
    it('should expose accomplish API via contextBridge', () => {
      expect(mockExposeInMainWorld).toHaveBeenCalledWith('accomplish', expect.any(Object));
      expect(capturedAccomplishAPI).toBeDefined();
    });

    it('should expose accomplishShell info via contextBridge', () => {
      expect(mockExposeInMainWorld).toHaveBeenCalledWith('accomplishShell', expect.any(Object));
      expect(capturedAccomplishShell).toBeDefined();
    });

    it('should expose shell info with isElectron=true', () => {
      expect(capturedAccomplishShell.isElectron).toBe(true);
    });

    it('should expose shell info with platform', () => {
      expect(capturedAccomplishShell.platform).toBe(process.platform);
    });

    it('should expose shell info with version matching package.json', () => {
      expect(capturedAccomplishShell.version).toBe(pkg.version);
    });
  });

  describe('IPC Method Invocations', () => {
    describe('App Info', () => {
      it('getVersion should invoke app:version', async () => {
        await (capturedAccomplishAPI.getVersion as () => Promise<string>)();
        expect(mockInvoke).toHaveBeenCalledWith('app:version');
      });

      it('getPlatform should invoke app:platform', async () => {
        await (capturedAccomplishAPI.getPlatform as () => Promise<string>)();
        expect(mockInvoke).toHaveBeenCalledWith('app:platform');
      });
    });

    describe('Shell Operations', () => {
      it('openExternal should invoke shell:open-external with URL', async () => {
        const url = 'https://example.com';
        await (capturedAccomplishAPI.openExternal as (url: string) => Promise<void>)(url);
        expect(mockInvoke).toHaveBeenCalledWith('shell:open-external', url);
      });
    });

    describe('Task Operations', () => {
      it('startTask should invoke task:start with config', async () => {
        const config = { description: 'Test task' };
        await (capturedAccomplishAPI.startTask as (config: { description: string }) => Promise<unknown>)(config);
        expect(mockInvoke).toHaveBeenCalledWith('task:start', config);
      });

      it('cancelTask should invoke task:cancel with taskId', async () => {
        await (capturedAccomplishAPI.cancelTask as (taskId: string) => Promise<void>)('task_123');
        expect(mockInvoke).toHaveBeenCalledWith('task:cancel', 'task_123');
      });

      it('interruptTask should invoke task:interrupt with taskId', async () => {
        await (capturedAccomplishAPI.interruptTask as (taskId: string) => Promise<void>)('task_123');
        expect(mockInvoke).toHaveBeenCalledWith('task:interrupt', 'task_123');
      });

      it('getTask should invoke task:get with taskId', async () => {
        await (capturedAccomplishAPI.getTask as (taskId: string) => Promise<unknown>)('task_123');
        expect(mockInvoke).toHaveBeenCalledWith('task:get', 'task_123');
      });

      it('listTasks should invoke task:list', async () => {
        await (capturedAccomplishAPI.listTasks as () => Promise<unknown[]>)();
        expect(mockInvoke).toHaveBeenCalledWith('task:list');
      });

      it('deleteTask should invoke task:delete with taskId', async () => {
        await (capturedAccomplishAPI.deleteTask as (taskId: string) => Promise<void>)('task_123');
        expect(mockInvoke).toHaveBeenCalledWith('task:delete', 'task_123');
      });

      it('clearTaskHistory should invoke task:clear-history', async () => {
        await (capturedAccomplishAPI.clearTaskHistory as () => Promise<void>)();
        expect(mockInvoke).toHaveBeenCalledWith('task:clear-history');
      });
    });

    describe('Permission Operations', () => {
      it('respondToPermission should invoke permission:respond', async () => {
        const response = { taskId: 'task_123', allowed: true };
        await (capturedAccomplishAPI.respondToPermission as (r: { taskId: string; allowed: boolean }) => Promise<void>)(response);
        expect(mockInvoke).toHaveBeenCalledWith('permission:respond', response);
      });
    });

    describe('Session Operations', () => {
      it('resumeSession should invoke session:resume', async () => {
        await (capturedAccomplishAPI.resumeSession as (s: string, p: string, t?: string) => Promise<unknown>)('session_123', 'Continue', 'task_456');
        expect(mockInvoke).toHaveBeenCalledWith('session:resume', 'session_123', 'Continue', 'task_456');
      });
    });

    describe('Settings Operations', () => {
      it('getDebugMode should invoke settings:debug-mode', async () => {
        await (capturedAccomplishAPI.getDebugMode as () => Promise<boolean>)();
        expect(mockInvoke).toHaveBeenCalledWith('settings:debug-mode');
      });

      it('setDebugMode should invoke settings:set-debug-mode', async () => {
        await (capturedAccomplishAPI.setDebugMode as (enabled: boolean) => Promise<void>)(true);
        expect(mockInvoke).toHaveBeenCalledWith('settings:set-debug-mode', true);
      });

      it('getAppSettings should invoke settings:app-settings', async () => {
        await (capturedAccomplishAPI.getAppSettings as () => Promise<unknown>)();
        expect(mockInvoke).toHaveBeenCalledWith('settings:app-settings');
      });
    });

    describe('API Key Operations', () => {
      it('hasApiKey should invoke api-key:exists', async () => {
        await (capturedAccomplishAPI.hasApiKey as () => Promise<boolean>)();
        expect(mockInvoke).toHaveBeenCalledWith('api-key:exists');
      });

      it('setApiKey should invoke api-key:set', async () => {
        await (capturedAccomplishAPI.setApiKey as (key: string) => Promise<void>)('sk-test');
        expect(mockInvoke).toHaveBeenCalledWith('api-key:set', 'sk-test');
      });

      it('getApiKey should invoke api-key:get', async () => {
        await (capturedAccomplishAPI.getApiKey as () => Promise<string | null>)();
        expect(mockInvoke).toHaveBeenCalledWith('api-key:get');
      });

      it('validateApiKey should invoke api-key:validate', async () => {
        await (capturedAccomplishAPI.validateApiKey as (key: string) => Promise<unknown>)('sk-test');
        expect(mockInvoke).toHaveBeenCalledWith('api-key:validate', 'sk-test');
      });

      it('clearApiKey should invoke api-key:clear', async () => {
        await (capturedAccomplishAPI.clearApiKey as () => Promise<void>)();
        expect(mockInvoke).toHaveBeenCalledWith('api-key:clear');
      });

      it('getAllApiKeys should invoke api-keys:all', async () => {
        await (capturedAccomplishAPI.getAllApiKeys as () => Promise<unknown>)();
        expect(mockInvoke).toHaveBeenCalledWith('api-keys:all');
      });

      it('hasAnyApiKey should invoke api-keys:has-any', async () => {
        await (capturedAccomplishAPI.hasAnyApiKey as () => Promise<boolean>)();
        expect(mockInvoke).toHaveBeenCalledWith('api-keys:has-any');
      });
    });

    describe('Onboarding Operations', () => {
      it('getOnboardingComplete should invoke onboarding:complete', async () => {
        await (capturedAccomplishAPI.getOnboardingComplete as () => Promise<boolean>)();
        expect(mockInvoke).toHaveBeenCalledWith('onboarding:complete');
      });

      it('setOnboardingComplete should invoke onboarding:set-complete', async () => {
        await (capturedAccomplishAPI.setOnboardingComplete as (c: boolean) => Promise<void>)(true);
        expect(mockInvoke).toHaveBeenCalledWith('onboarding:set-complete', true);
      });
    });

    describe('Model Operations', () => {
      it('getSelectedModel should invoke model:get', async () => {
        await (capturedAccomplishAPI.getSelectedModel as () => Promise<unknown>)();
        expect(mockInvoke).toHaveBeenCalledWith('model:get');
      });

      it('setSelectedModel should invoke model:set', async () => {
        const model = { provider: 'anthropic', model: 'claude-3-opus' };
        await (capturedAccomplishAPI.setSelectedModel as (m: { provider: string; model: string }) => Promise<void>)(model);
        expect(mockInvoke).toHaveBeenCalledWith('model:set', model);
      });
    });

    describe('Logging Operations', () => {
      it('logEvent should invoke log:event', async () => {
        const payload = { level: 'info', message: 'Test' };
        await (capturedAccomplishAPI.logEvent as (p: unknown) => Promise<unknown>)(payload);
        expect(mockInvoke).toHaveBeenCalledWith('log:event', payload);
      });
    });
  });

  describe('Event Subscriptions', () => {
    it('onTaskUpdate should subscribe to task:update', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onTaskUpdate as (cb: (e: unknown) => void) => () => void)(callback);
      expect(mockOn).toHaveBeenCalledWith('task:update', expect.any(Function));
    });

    it('onTaskUpdate should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = (capturedAccomplishAPI.onTaskUpdate as (cb: (e: unknown) => void) => () => void)(callback);
      unsubscribe();
      expect(mockRemoveListener).toHaveBeenCalledWith('task:update', expect.any(Function));
    });

    it('onTaskUpdateBatch should subscribe to task:update:batch', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onTaskUpdateBatch as (cb: (e: unknown) => void) => () => void)(callback);
      expect(mockOn).toHaveBeenCalledWith('task:update:batch', expect.any(Function));
    });

    it('onPermissionRequest should subscribe to permission:request', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onPermissionRequest as (cb: (e: unknown) => void) => () => void)(callback);
      expect(mockOn).toHaveBeenCalledWith('permission:request', expect.any(Function));
    });

    it('onTaskProgress should subscribe to task:progress', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onTaskProgress as (cb: (e: unknown) => void) => () => void)(callback);
      expect(mockOn).toHaveBeenCalledWith('task:progress', expect.any(Function));
    });

    it('onDebugLog should subscribe to debug:log', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onDebugLog as (cb: (e: unknown) => void) => () => void)(callback);
      expect(mockOn).toHaveBeenCalledWith('debug:log', expect.any(Function));
    });

    it('onTaskStatusChange should subscribe to task:status-change', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onTaskStatusChange as (cb: (e: unknown) => void) => () => void)(callback);
      expect(mockOn).toHaveBeenCalledWith('task:status-change', expect.any(Function));
    });
  });

  describe('Event Callback Invocation', () => {
    it('onTaskUpdate callback should receive event data', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onTaskUpdate as (cb: (e: unknown) => void) => () => void)(callback);

      // Get the registered listener from mockOn calls
      const registeredListener = mockOn.mock.calls.find(
        (call: unknown[]) => call[0] === 'task:update'
      )?.[1] as (event: unknown, data: unknown) => void;

      // Simulate IPC event
      const eventData = { taskId: 'task_123', type: 'message' };
      registeredListener(null, eventData);

      expect(callback).toHaveBeenCalledWith(eventData);
    });

    it('onPermissionRequest callback should receive request data', () => {
      const callback = vi.fn();
      (capturedAccomplishAPI.onPermissionRequest as (cb: (e: unknown) => void) => () => void)(callback);

      const registeredListener = mockOn.mock.calls.find(
        (call: unknown[]) => call[0] === 'permission:request'
      )?.[1] as (event: unknown, data: unknown) => void;

      const requestData = { id: 'req_123', taskId: 'task_456' };
      registeredListener(null, requestData);

      expect(callback).toHaveBeenCalledWith(requestData);
    });
  });
});
