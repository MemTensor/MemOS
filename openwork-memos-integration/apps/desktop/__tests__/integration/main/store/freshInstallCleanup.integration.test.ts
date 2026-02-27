/**
 * Integration tests for Fresh Install Cleanup
 *
 * Tests the REAL checkAndCleanupFreshInstall function:
 * - Returns false in dev mode (app.isPackaged = false)
 * - Returns false when bundle mtime cannot be determined
 *
 * These tests mock external dependencies (electron, fs, store modules)
 * and verify the actual module behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted() to ensure mock functions are available when vi.mock is hoisted
const {
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockStatSync,
  mockMkdirSync,
  mockUnlinkSync,
  mockGetPath,
  mockGetVersion,
  mockClearAppSettings,
  mockClearTaskHistoryStore,
  mockClearSecureStorage,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockGetPath: vi.fn(),
  mockGetVersion: vi.fn(),
  mockClearAppSettings: vi.fn(),
  mockClearTaskHistoryStore: vi.fn(),
  mockClearSecureStorage: vi.fn(),
}));

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    statSync: mockStatSync,
    mkdirSync: mockMkdirSync,
    unlinkSync: mockUnlinkSync,
  },
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  statSync: mockStatSync,
  mkdirSync: mockMkdirSync,
  unlinkSync: mockUnlinkSync,
}));

// Mock electron app - isPackaged starts as false (dev mode)
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: mockGetPath,
    getVersion: mockGetVersion,
  },
}));

// Mock store modules
vi.mock('@main/store/appSettings', () => ({
  clearAppSettings: mockClearAppSettings,
}));

vi.mock('@main/store/taskHistory', () => ({
  clearTaskHistoryStore: mockClearTaskHistoryStore,
}));

vi.mock('@main/store/secureStorage', () => ({
  clearSecureStorage: mockClearSecureStorage,
}));

// Import the REAL module function after mocking dependencies
import { checkAndCleanupFreshInstall } from '@main/store/freshInstallCleanup';
import { app } from 'electron';

describe('Fresh Install Cleanup Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to dev mode by default
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
    // Setup default path mocks
    mockGetPath.mockImplementation((name: string) => {
      const paths: Record<string, string> = {
        userData: '/tmp/test-app/userData',
        appData: '/tmp/test-app/appData',
        exe: '/Applications/Accomplish.app/Contents/MacOS/Accomplish',
      };
      return paths[name] || '/tmp/test-app';
    });
    mockGetVersion.mockReturnValue('1.0.0');
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Reset to dev mode
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
  });

  describe('checkAndCleanupFreshInstall', () => {
    it('should return false in dev mode (app.isPackaged = false)', async () => {
      // Arrange - dev mode is the default in beforeEach
      expect(app.isPackaged).toBe(false);

      // Act - call the REAL function
      const result = await checkAndCleanupFreshInstall();

      // Assert
      expect(result).toBe(false);
      // Should not call any cleanup functions in dev mode
      expect(mockClearAppSettings).not.toHaveBeenCalled();
      expect(mockClearTaskHistoryStore).not.toHaveBeenCalled();
      expect(mockClearSecureStorage).not.toHaveBeenCalled();
    });

    it('should return false when exe path does not contain .app bundle', async () => {
      // Arrange - set to packaged mode but with non-.app exe path
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      mockGetPath.mockImplementation((name: string) => {
        if (name === 'exe') return '/usr/local/bin/accomplish'; // No .app in path
        return '/tmp/test-app/userData';
      });

      // Act
      const result = await checkAndCleanupFreshInstall();

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when bundle stat fails', async () => {
      // Arrange - set to packaged mode with valid .app path but stat fails
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      // Act
      const result = await checkAndCleanupFreshInstall();

      // Assert
      expect(result).toBe(false);
    });

    it('should return false on first install (no existing data)', async () => {
      // Arrange - packaged mode, valid bundle, but no existing data
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      const currentMtime = new Date('2024-06-01T00:00:00.000Z');
      mockStatSync.mockReturnValue({ mtime: currentMtime });
      mockExistsSync.mockReturnValue(false); // No existing marker or data

      // Act
      const result = await checkAndCleanupFreshInstall();

      // Assert - first install creates marker but doesn't cleanup (returns false)
      expect(result).toBe(false);
      // Should write the marker file
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('should return false when marker matches current bundle', async () => {
      // Arrange - packaged mode, marker exists and matches
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      const currentMtime = new Date('2024-06-01T00:00:00.000Z');
      mockStatSync.mockReturnValue({ mtime: currentMtime });

      const existingMarker = {
        bundleMtime: currentMtime.toISOString(),
        version: '1.0.0',
        markerCreated: '2024-06-01T00:00:00.000Z',
      };

      mockExistsSync.mockImplementation((path: string) => {
        return path.includes('.install-marker.json');
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(existingMarker));

      // Act
      const result = await checkAndCleanupFreshInstall();

      // Assert - no cleanup needed
      expect(result).toBe(false);
      expect(mockClearAppSettings).not.toHaveBeenCalled();
    });

    it('should return true and cleanup when bundle mtime differs from marker', async () => {
      // Arrange - packaged mode, marker exists but bundle changed
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      const currentMtime = new Date('2024-07-01T00:00:00.000Z'); // New version
      mockStatSync.mockReturnValue({ mtime: currentMtime });

      const existingMarker = {
        bundleMtime: '2024-06-01T00:00:00.000Z', // Old version
        version: '1.0.0',
        markerCreated: '2024-06-01T00:00:00.000Z',
      };

      mockExistsSync.mockImplementation((path: string) => {
        return path.includes('.install-marker.json');
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(existingMarker));

      // Act
      const result = await checkAndCleanupFreshInstall();

      // Assert - cleanup was performed
      expect(result).toBe(true);
      expect(mockClearAppSettings).toHaveBeenCalled();
      expect(mockClearTaskHistoryStore).toHaveBeenCalled();
      expect(mockClearSecureStorage).toHaveBeenCalled();
    });

    it('should return true and cleanup on reinstall (existing data but no marker)', async () => {
      // Arrange - packaged mode, no marker but has existing settings file
      (app as unknown as { isPackaged: boolean }).isPackaged = true;
      const currentMtime = new Date('2024-06-01T00:00:00.000Z');
      mockStatSync.mockReturnValue({ mtime: currentMtime });

      // No marker, but app-settings.json exists
      mockExistsSync.mockImplementation((path: string) => {
        if (path.includes('.install-marker.json')) return false;
        if (path.includes('app-settings.json')) return true;
        return false;
      });

      // Act
      const result = await checkAndCleanupFreshInstall();

      // Assert - cleanup was performed (reinstall scenario)
      expect(result).toBe(true);
      expect(mockClearAppSettings).toHaveBeenCalled();
      expect(mockClearTaskHistoryStore).toHaveBeenCalled();
      expect(mockClearSecureStorage).toHaveBeenCalled();
    });
  });
});
