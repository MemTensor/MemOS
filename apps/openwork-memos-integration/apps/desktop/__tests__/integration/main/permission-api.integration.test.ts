/**
 * Integration tests for Permission API
 *
 * Tests the REAL exported functions from permission-api module:
 * - isFilePermissionRequest() - checks if request ID is a file permission
 * - resolvePermission() - resolves a pending permission request
 * - initPermissionApi() - initializes the API with window and task getter
 * - startPermissionApiServer() - starts the HTTP server
 * - PERMISSION_API_PORT - the port constant
 *
 * These tests mock only electron (external dependency) and test the real
 * module behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron before importing the module
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/test-app'),
  },
}));

// Import the REAL module functions after mocking electron
import {
  isFilePermissionRequest,
  resolvePermission,
  initPermissionApi,
  startPermissionApiServer,
  PERMISSION_API_PORT,
} from '@main/permission-api';

describe('Permission API Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isFilePermissionRequest', () => {
    it('should return true for IDs starting with filereq_', () => {
      expect(isFilePermissionRequest('filereq_123')).toBe(true);
      expect(isFilePermissionRequest('filereq_abc_def')).toBe(true);
      expect(isFilePermissionRequest('filereq_1234567890_abcdefghi')).toBe(true);
      expect(isFilePermissionRequest('filereq_')).toBe(true);
    });

    it('should return false for IDs not starting with filereq_', () => {
      expect(isFilePermissionRequest('req_123')).toBe(false);
      expect(isFilePermissionRequest('permission_abc')).toBe(false);
      expect(isFilePermissionRequest('file_req_123')).toBe(false);
      expect(isFilePermissionRequest('FILEREQ_123')).toBe(false); // case sensitive
      expect(isFilePermissionRequest('')).toBe(false);
      expect(isFilePermissionRequest('filereq')).toBe(false); // missing underscore
      expect(isFilePermissionRequest('_filereq_123')).toBe(false);
    });
  });

  describe('resolvePermission', () => {
    it('should return false for non-existent request ID', () => {
      // The real function returns false when the request is not in pending
      expect(resolvePermission('filereq_nonexistent', true)).toBe(false);
      expect(resolvePermission('filereq_notpending', false)).toBe(false);
    });

    it('should return false when called multiple times with same ID', () => {
      const requestId = 'filereq_double_resolve';
      // First call returns false (not pending)
      expect(resolvePermission(requestId, true)).toBe(false);
      // Second call also returns false (still not pending)
      expect(resolvePermission(requestId, false)).toBe(false);
    });
  });

  describe('PERMISSION_API_PORT', () => {
    it('should be exported with correct value', () => {
      expect(PERMISSION_API_PORT).toBe(9226);
    });
  });

  describe('initPermissionApi', () => {
    it('should accept window and task getter without throwing', () => {
      const mockWindow = {
        isDestroyed: () => false,
        webContents: {
          send: vi.fn(),
          isDestroyed: () => false,
        },
      } as unknown as import('electron').BrowserWindow;
      const mockTaskGetter = () => 'task_123';

      expect(() => initPermissionApi(mockWindow, mockTaskGetter)).not.toThrow();
    });

    it('should be a function', () => {
      expect(typeof initPermissionApi).toBe('function');
    });
  });

  describe('startPermissionApiServer', () => {
    it('should be a function', () => {
      expect(typeof startPermissionApiServer).toBe('function');
    });

    it('should return an HTTP server when called', () => {
      const server = startPermissionApiServer();
      expect(server).toBeDefined();
      // Clean up - close the server
      server?.close();
    });
  });
});
