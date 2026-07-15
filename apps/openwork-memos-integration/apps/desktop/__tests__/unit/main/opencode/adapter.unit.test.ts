/**
 * Unit tests for OpenCode Adapter
 *
 * Tests the adapter module which manages PTY spawning, stream parsing,
 * and event handling for OpenCode CLI interactions.
 *
 * NOTE: This is a UNIT test, not an integration test.
 * External dependencies (node-pty, fs, child_process) are mocked to test
 * adapter logic in isolation. Internal modules (secureStorage, appSettings,
 * config-generator) are also mocked since this tests the adapter's behavior
 * independent of those implementations.
 *
 * Mocked external services:
 * - node-pty: External process spawning (PTY terminal)
 * - electron: Native desktop APIs
 * - child_process: Process execution
 *
 * @module __tests__/unit/main/opencode/adapter.unit.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type {
  OpenCodeStepStartMessage,
  OpenCodeTextMessage,
  OpenCodeToolCallMessage,
  OpenCodeToolUseMessage,
  OpenCodeStepFinishMessage,
  OpenCodeErrorMessage,
} from '@accomplish/shared';

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
  existsSync: vi.fn(() => true),
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

// Create a mock PTY process
class MockPty extends EventEmitter {
  pid = 12345;
  killed = false;

  write = vi.fn();
  kill = vi.fn(() => {
    this.killed = true;
  });

  // Helper to simulate data events
  simulateData(data: string) {
    const callbacks = this.listeners('data');
    callbacks.forEach((cb) => (cb as (data: string) => void)(data));
  }

  // Helper to simulate exit
  simulateExit(exitCode: number, signal?: number) {
    const callbacks = this.listeners('exit');
    callbacks.forEach((cb) => (cb as (params: { exitCode: number; signal?: number }) => void)({ exitCode, signal }));
  }

  // Override on to use onData/onExit interface
  onData(callback: (data: string) => void) {
    this.on('data', callback);
    return { dispose: () => this.off('data', callback) };
  }

  onExit(callback: (params: { exitCode: number; signal?: number }) => void) {
    this.on('exit', callback);
    return { dispose: () => this.off('exit', callback) };
  }
}

// Mock node-pty
const mockPtyInstance = new MockPty();
const mockPtySpawn = vi.fn(() => mockPtyInstance);

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
}));

// Mock child_process for execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/opencode'),
}));

// Mock secure storage
vi.mock('@main/store/secureStorage', () => ({
  getAllApiKeys: vi.fn(() => Promise.resolve({
    anthropic: 'test-anthropic-key',
    openai: 'test-openai-key',
  })),
  getBedrockCredentials: vi.fn(() => null),
}));

// Mock app settings
vi.mock('@main/store/appSettings', () => ({
  getSelectedModel: vi.fn(() => ({ model: 'claude-3-opus-20240229' })),
}));

// Mock config generator
vi.mock('@main/opencode/config-generator', () => ({
  generateOpenCodeConfig: vi.fn(() => Promise.resolve('/mock/config/path')),
  syncApiKeysToOpenCodeAuth: vi.fn(() => Promise.resolve()),
  ACCOMPLISH_AGENT_NAME: 'accomplish',
}));

// Mock system-path
vi.mock('@main/utils/system-path', () => ({
  getExtendedNodePath: vi.fn((basePath: string) => basePath || '/usr/bin'),
}));

// Mock bundled-node
vi.mock('@main/utils/bundled-node', () => ({
  getBundledNodePaths: vi.fn(() => null),
  logBundledNodeInfo: vi.fn(),
}));

// Mock permission-api
vi.mock('@main/permission-api', () => ({
  PERMISSION_API_PORT: 9999,
}));

describe('OpenCode Adapter Module', () => {
  let OpenCodeAdapter: typeof import('@main/opencode/adapter').OpenCodeAdapter;
  let createAdapter: typeof import('@main/opencode/adapter').createAdapter;
  let isOpenCodeCliInstalled: typeof import('@main/opencode/adapter').isOpenCodeCliInstalled;
  let getOpenCodeCliVersion: typeof import('@main/opencode/adapter').getOpenCodeCliVersion;
  let OpenCodeCliNotFoundError: typeof import('@main/opencode/adapter').OpenCodeCliNotFoundError;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create a fresh mock PTY for each test
    Object.assign(mockPtyInstance, new MockPty());
    mockPtyInstance.killed = false;
    mockPtyInstance.removeAllListeners();

    // Re-import module to get fresh state
    const module = await import('@main/opencode/adapter');
    OpenCodeAdapter = module.OpenCodeAdapter;
    createAdapter = module.createAdapter;
    isOpenCodeCliInstalled = module.isOpenCodeCliInstalled;
    getOpenCodeCliVersion = module.getOpenCodeCliVersion;
    OpenCodeCliNotFoundError = module.OpenCodeCliNotFoundError;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe('OpenCodeAdapter Class', () => {
    describe('Constructor', () => {
      it('should create adapter instance with optional task ID', () => {
        // Act
        const adapter = new OpenCodeAdapter('test-task-123');

        // Assert
        expect(adapter.getTaskId()).toBe('test-task-123');
        expect(adapter.isAdapterDisposed()).toBe(false);
      });

      it('should create adapter instance without task ID', () => {
        // Act
        const adapter = new OpenCodeAdapter();

        // Assert
        expect(adapter.getTaskId()).toBeNull();
      });
    });

    describe('startTask()', () => {
      it('should spawn PTY process with correct arguments', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter('test-task');
        const config = {
          prompt: 'Test prompt',
          taskId: 'test-task-123',
        };

        // Act
        const task = await adapter.startTask(config);

        // Assert
        expect(mockPtySpawn).toHaveBeenCalled();
        expect(task.id).toBe('test-task-123');
        expect(task.prompt).toBe('Test prompt');
        expect(task.status).toBe('running');
      });

      it('should generate task ID if not provided', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const config = { prompt: 'Test prompt' };

        // Act
        const task = await adapter.startTask(config);

        // Assert
        expect(task.id).toMatch(/^task_\d+_[a-z0-9]+$/);
      });

      it('should emit debug events during startup', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const debugEvents: Array<{ type: string; message: string }> = [];
        adapter.on('debug', (log) => debugEvents.push(log));

        // Act
        await adapter.startTask({ prompt: 'Test' });

        // Assert
        expect(debugEvents.length).toBeGreaterThan(0);
        expect(debugEvents.some((e) => e.type === 'info')).toBe(true);
      });

      it('should throw error if adapter is disposed', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        adapter.dispose();

        // Act & Assert
        await expect(adapter.startTask({ prompt: 'Test' })).rejects.toThrow(
          'Adapter has been disposed'
        );
      });
    });

    describe('Event Emission', () => {
      it('should emit message event when receiving text message', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const messages: unknown[] = [];
        adapter.on('message', (msg) => messages.push(msg));

        await adapter.startTask({ prompt: 'Test' });

        const textMessage: OpenCodeTextMessage = {
          type: 'text',
          part: {
            id: 'msg-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'text',
            text: 'Hello, I am assisting you.',
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(textMessage) + '\n');

        // Assert
        expect(messages.length).toBe(1);
        expect(messages[0]).toMatchObject({ type: 'text' });
      });

      it('should emit progress event on step_start message', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const progressEvents: Array<{ stage: string; message?: string }> = [];
        adapter.on('progress', (p) => progressEvents.push(p));

        await adapter.startTask({ prompt: 'Test' });

        const stepStartMessage: OpenCodeStepStartMessage = {
          type: 'step_start',
          part: {
            id: 'step-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'step-start',
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(stepStartMessage) + '\n');

        // Assert
        expect(progressEvents.length).toBe(1);
        expect(progressEvents[0].stage).toBe('init');
      });

      it('should emit tool-use event on tool_call message', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const toolEvents: Array<[string, unknown]> = [];
        adapter.on('tool-use', (name, input) => toolEvents.push([name, input]));

        await adapter.startTask({ prompt: 'Test' });

        const toolCallMessage: OpenCodeToolCallMessage = {
          type: 'tool_call',
          part: {
            id: 'tool-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'tool-call',
            tool: 'Bash',
            input: { command: 'ls -la' },
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(toolCallMessage) + '\n');

        // Assert
        expect(toolEvents.length).toBe(1);
        expect(toolEvents[0][0]).toBe('Bash');
        expect(toolEvents[0][1]).toEqual({ command: 'ls -la' });
      });

      it('should emit tool-use and tool-result events on tool_use message', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const toolUseEvents: Array<[string, unknown]> = [];
        const toolResultEvents: string[] = [];
        adapter.on('tool-use', (name, input) => toolUseEvents.push([name, input]));
        adapter.on('tool-result', (output) => toolResultEvents.push(output));

        await adapter.startTask({ prompt: 'Test' });

        const toolUseMessage: OpenCodeToolUseMessage = {
          type: 'tool_use',
          part: {
            id: 'tool-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'tool',
            tool: 'Read',
            state: {
              status: 'completed',
              input: { path: '/test/file.txt' },
              output: 'File contents here',
            },
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(toolUseMessage) + '\n');

        // Assert
        expect(toolUseEvents.length).toBe(1);
        expect(toolUseEvents[0][0]).toBe('Read');
        expect(toolResultEvents.length).toBe(1);
        expect(toolResultEvents[0]).toBe('File contents here');
      });

      it('should emit complete event on step_finish with stop reason', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const completeEvents: Array<{ status: string; sessionId?: string }> = [];
        adapter.on('complete', (result) => completeEvents.push(result));

        await adapter.startTask({ prompt: 'Test' });

        const stepFinishMessage: OpenCodeStepFinishMessage = {
          type: 'step_finish',
          part: {
            id: 'step-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'step-finish',
            reason: 'stop',
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(stepFinishMessage) + '\n');

        // Assert
        expect(completeEvents.length).toBe(1);
        expect(completeEvents[0].status).toBe('success');
      });

      it('should not emit complete event on step_finish with tool_use reason', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const completeEvents: Array<{ status: string }> = [];
        adapter.on('complete', (result) => completeEvents.push(result));

        await adapter.startTask({ prompt: 'Test' });

        const stepFinishMessage: OpenCodeStepFinishMessage = {
          type: 'step_finish',
          part: {
            id: 'step-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'step-finish',
            reason: 'tool_use',
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(stepFinishMessage) + '\n');

        // Assert
        expect(completeEvents.length).toBe(0);
      });

      it('should emit complete with error status on error message', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const completeEvents: Array<{ status: string; error?: string }> = [];
        adapter.on('complete', (result) => completeEvents.push(result));

        await adapter.startTask({ prompt: 'Test' });

        const errorMessage: OpenCodeErrorMessage = {
          type: 'error',
          error: 'Something went wrong',
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(errorMessage) + '\n');

        // Assert
        expect(completeEvents.length).toBe(1);
        expect(completeEvents[0].status).toBe('error');
        expect(completeEvents[0].error).toBe('Something went wrong');
      });

      it('should emit permission-request event for AskUserQuestion tool', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter('test-task');
        const permissionRequests: unknown[] = [];
        adapter.on('permission-request', (req) => permissionRequests.push(req));

        await adapter.startTask({ prompt: 'Test' });

        const toolCallMessage: OpenCodeToolCallMessage = {
          type: 'tool_call',
          part: {
            id: 'tool-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'tool-call',
            tool: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Do you want to proceed?',
                  options: [
                    { label: 'Yes', description: 'Proceed with action' },
                    { label: 'No', description: 'Cancel' },
                  ],
                },
              ],
            },
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(toolCallMessage) + '\n');

        // Assert
        expect(permissionRequests.length).toBe(1);
        const req = permissionRequests[0] as { question: string; options: Array<{ label: string }> };
        expect(req.question).toBe('Do you want to proceed?');
        expect(req.options).toHaveLength(2);
      });
    });

    describe('Stream Parser Integration', () => {
      it('should handle multiple JSON messages in single data chunk', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const messages: unknown[] = [];
        adapter.on('message', (msg) => messages.push(msg));

        await adapter.startTask({ prompt: 'Test' });

        const message1: OpenCodeTextMessage = {
          type: 'text',
          part: { id: '1', sessionID: 's', messageID: 'm', type: 'text', text: 'First' },
        };
        const message2: OpenCodeTextMessage = {
          type: 'text',
          part: { id: '2', sessionID: 's', messageID: 'm', type: 'text', text: 'Second' },
        };

        // Act
        mockPtyInstance.simulateData(
          JSON.stringify(message1) + '\n' + JSON.stringify(message2) + '\n'
        );

        // Assert
        expect(messages.length).toBe(2);
      });

      it('should handle split JSON messages across data chunks', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const messages: unknown[] = [];
        adapter.on('message', (msg) => messages.push(msg));

        await adapter.startTask({ prompt: 'Test' });

        const fullMessage: OpenCodeTextMessage = {
          type: 'text',
          part: { id: '1', sessionID: 's', messageID: 'm', type: 'text', text: 'Complete message' },
        };
        const jsonStr = JSON.stringify(fullMessage);
        const splitPoint = Math.floor(jsonStr.length / 2);

        // Act - send message in two parts
        mockPtyInstance.simulateData(jsonStr.substring(0, splitPoint));
        mockPtyInstance.simulateData(jsonStr.substring(splitPoint) + '\n');

        // Assert
        expect(messages.length).toBe(1);
      });

      it('should skip non-JSON lines without crashing', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const messages: unknown[] = [];
        const debugEvents: unknown[] = [];
        adapter.on('message', (msg) => messages.push(msg));
        adapter.on('debug', (d) => debugEvents.push(d));

        await adapter.startTask({ prompt: 'Test' });

        const validMessage: OpenCodeTextMessage = {
          type: 'text',
          part: { id: '1', sessionID: 's', messageID: 'm', type: 'text', text: 'Valid' },
        };

        // Act - send non-JSON followed by valid JSON
        mockPtyInstance.simulateData('Shell banner: Welcome to zsh\n');
        mockPtyInstance.simulateData(JSON.stringify(validMessage) + '\n');

        // Assert
        expect(messages.length).toBe(1);
      });

      it('should strip ANSI escape codes from data', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const messages: unknown[] = [];
        adapter.on('message', (msg) => messages.push(msg));

        await adapter.startTask({ prompt: 'Test' });

        const validMessage: OpenCodeTextMessage = {
          type: 'text',
          part: { id: '1', sessionID: 's', messageID: 'm', type: 'text', text: 'Valid' },
        };

        // Act - send JSON with ANSI codes
        const ansiWrapped = '\x1B[32m' + JSON.stringify(validMessage) + '\x1B[0m\n';
        mockPtyInstance.simulateData(ansiWrapped);

        // Assert
        expect(messages.length).toBe(1);
      });
    });

    describe('Process Exit Handling', () => {
      it('should emit complete on normal exit (code 0)', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const completeEvents: Array<{ status: string }> = [];
        adapter.on('complete', (result) => completeEvents.push(result));

        await adapter.startTask({ prompt: 'Test' });

        // Act
        mockPtyInstance.simulateExit(0);

        // Assert
        expect(completeEvents.length).toBe(1);
        expect(completeEvents[0].status).toBe('success');
      });

      it('should emit error on non-zero exit code', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const errorEvents: Error[] = [];
        adapter.on('error', (err) => errorEvents.push(err));

        await adapter.startTask({ prompt: 'Test' });

        // Act
        mockPtyInstance.simulateExit(1);

        // Assert
        expect(errorEvents.length).toBe(1);
        expect(errorEvents[0].message).toContain('exited with code 1');
      });

      it('should emit interrupted status when interrupted', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const completeEvents: Array<{ status: string }> = [];
        adapter.on('complete', (result) => completeEvents.push(result));

        await adapter.startTask({ prompt: 'Test' });

        // Act
        await adapter.interruptTask();
        mockPtyInstance.simulateExit(0);

        // Assert
        expect(completeEvents.length).toBe(1);
        expect(completeEvents[0].status).toBe('interrupted');
      });

      it('should not emit duplicate complete events', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        const completeEvents: Array<{ status: string }> = [];
        adapter.on('complete', (result) => completeEvents.push(result));

        await adapter.startTask({ prompt: 'Test' });

        // Emit step_finish first (marks hasCompleted = true)
        const stepFinish: OpenCodeStepFinishMessage = {
          type: 'step_finish',
          part: {
            id: 'step-1',
            sessionID: 'session-123',
            messageID: 'message-123',
            type: 'step-finish',
            reason: 'stop',
          },
        };
        mockPtyInstance.simulateData(JSON.stringify(stepFinish) + '\n');

        // Act - then exit
        mockPtyInstance.simulateExit(0);

        // Assert - should only have one complete event
        expect(completeEvents.length).toBe(1);
      });
    });

    describe('sendResponse()', () => {
      it('should write response to PTY', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        await adapter.startTask({ prompt: 'Test' });

        // Act
        await adapter.sendResponse('user input');

        // Assert
        expect(mockPtyInstance.write).toHaveBeenCalledWith('user input\n');
      });

      it('should throw error if no active process', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        // Don't start a task

        // Act & Assert
        await expect(adapter.sendResponse('input')).rejects.toThrow('No active process');
      });
    });

    describe('cancelTask()', () => {
      it('should kill PTY process', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        await adapter.startTask({ prompt: 'Test' });

        // Act
        await adapter.cancelTask();

        // Assert
        expect(mockPtyInstance.kill).toHaveBeenCalled();
      });
    });

    describe('interruptTask()', () => {
      it('should send Ctrl+C to PTY', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        await adapter.startTask({ prompt: 'Test' });

        // Act
        await adapter.interruptTask();

        // Assert
        expect(mockPtyInstance.write).toHaveBeenCalledWith('\x03');
      });

      it('should handle interrupt when no active process', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        // Don't start a task

        // Act - should not throw
        await adapter.interruptTask();

        // Assert
        expect(mockPtyInstance.write).not.toHaveBeenCalled();
      });
    });

    describe('dispose()', () => {
      it('should cleanup PTY process and state', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter('test-task');
        await adapter.startTask({ prompt: 'Test' });

        // Act
        adapter.dispose();

        // Assert
        expect(adapter.isAdapterDisposed()).toBe(true);
        expect(adapter.getTaskId()).toBeNull();
        expect(adapter.getSessionId()).toBeNull();
        expect(mockPtyInstance.kill).toHaveBeenCalled();
      });

      it('should be idempotent (safe to call multiple times)', () => {
        // Arrange
        const adapter = new OpenCodeAdapter();

        // Act - call dispose multiple times
        adapter.dispose();
        adapter.dispose();
        adapter.dispose();

        // Assert - should not throw
        expect(adapter.isAdapterDisposed()).toBe(true);
      });

      it('should remove all event listeners', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        let messageCount = 0;
        adapter.on('message', () => messageCount++);
        await adapter.startTask({ prompt: 'Test' });

        // Act
        adapter.dispose();
        adapter.emit('message', {} as OpenCodeTextMessage);

        // Assert - listener should have been removed
        expect(messageCount).toBe(0);
      });
    });

    describe('Session Management', () => {
      it('should track session ID from step_start message', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();
        await adapter.startTask({ prompt: 'Test' });

        const stepStart: OpenCodeStepStartMessage = {
          type: 'step_start',
          part: {
            id: 'step-1',
            sessionID: 'session-abc-123',
            messageID: 'message-123',
            type: 'step-start',
          },
        };

        // Act
        mockPtyInstance.simulateData(JSON.stringify(stepStart) + '\n');

        // Assert
        expect(adapter.getSessionId()).toBe('session-abc-123');
      });

      it('should support resuming sessions', async () => {
        // Arrange
        const adapter = new OpenCodeAdapter();

        // Act
        const task = await adapter.resumeSession('existing-session', 'Continue task');

        // Assert
        expect(task.prompt).toBe('Continue task');
        expect(mockPtySpawn).toHaveBeenCalled();
      });
    });
  });

  describe('Factory Functions', () => {
    describe('createAdapter()', () => {
      it('should create a new adapter instance', () => {
        // Act
        const adapter = createAdapter('task-123');

        // Assert
        expect(adapter).toBeInstanceOf(OpenCodeAdapter);
        expect(adapter.getTaskId()).toBe('task-123');
      });
    });

    describe('isOpenCodeCliInstalled()', () => {
      it('should return boolean indicating CLI availability', async () => {
        // Act
        const result = await isOpenCodeCliInstalled();

        // Assert
        expect(typeof result).toBe('boolean');
      });
    });

    describe('getOpenCodeCliVersion()', () => {
      it('should return version string or null', async () => {
        // Act
        const result = await getOpenCodeCliVersion();

        // Assert
        expect(result === null || typeof result === 'string').toBe(true);
      });
    });
  });

  describe('OpenCodeCliNotFoundError', () => {
    it('should have correct error name', () => {
      // Act
      const error = new OpenCodeCliNotFoundError();

      // Assert
      expect(error.name).toBe('OpenCodeCliNotFoundError');
    });

    it('should have descriptive message', () => {
      // Act
      const error = new OpenCodeCliNotFoundError();

      // Assert
      expect(error.message).toContain('OpenCode CLI is not available');
      expect(error.message).toContain('reinstall');
    });
  });
});
