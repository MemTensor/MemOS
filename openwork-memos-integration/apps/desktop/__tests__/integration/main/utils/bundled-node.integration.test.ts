/**
 * Integration tests for Bundled Node.js utilities
 *
 * Tests the bundled-node module which provides paths to bundled Node.js
 * binaries for packaged Electron apps.
 *
 * @module __tests__/integration/main/utils/bundled-node.integration.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'path';

// Store original values
const originalPlatform = process.platform;
const originalArch = process.arch;

// Mock electron module
const mockApp = {
  isPackaged: false,
};

vi.mock('electron', () => ({
  app: mockApp,
}));

// Mock fs module
const mockFs = {
  existsSync: vi.fn(),
};

vi.mock('fs', () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
}));

describe('Bundled Node.js Utilities', () => {
  let getBundledNodePaths: typeof import('@main/utils/bundled-node').getBundledNodePaths;
  let isBundledNodeAvailable: typeof import('@main/utils/bundled-node').isBundledNodeAvailable;
  let getNodePath: typeof import('@main/utils/bundled-node').getNodePath;
  let getNpmPath: typeof import('@main/utils/bundled-node').getNpmPath;
  let getNpxPath: typeof import('@main/utils/bundled-node').getNpxPath;
  let logBundledNodeInfo: typeof import('@main/utils/bundled-node').logBundledNodeInfo;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockApp.isPackaged = false;

    // Re-import module to get fresh state
    const module = await import('@main/utils/bundled-node');
    getBundledNodePaths = module.getBundledNodePaths;
    isBundledNodeAvailable = module.isBundledNodeAvailable;
    getNodePath = module.getNodePath;
    getNpmPath = module.getNpmPath;
    getNpxPath = module.getNpxPath;
    logBundledNodeInfo = module.logBundledNodeInfo;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore platform/arch
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  describe('getBundledNodePaths()', () => {
    describe('Development Mode', () => {
      it('should return null in development mode', () => {
        // Arrange
        mockApp.isPackaged = false;

        // Act
        const result = getBundledNodePaths();

        // Assert
        expect(result).toBeNull();
      });
    });

    describe('Packaged Mode - macOS (darwin)', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
      });

      it('should return correct paths for arm64 architecture', async () => {
        // Arrange
        mockApp.isPackaged = true;
        Object.defineProperty(process, 'arch', { value: 'arm64' });
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        // Re-import to pick up new process values
        vi.resetModules();
        const module = await import('@main/utils/bundled-node');
        const paths = module.getBundledNodePaths();

        // Assert
        expect(paths).not.toBeNull();
        expect(paths!.nodeDir).toBe(path.join(resourcesPath, 'nodejs', 'arm64'));
        expect(paths!.binDir).toBe(path.join(resourcesPath, 'nodejs', 'arm64', 'bin'));
        expect(paths!.nodePath).toBe(path.join(resourcesPath, 'nodejs', 'arm64', 'bin', 'node'));
        expect(paths!.npmPath).toBe(path.join(resourcesPath, 'nodejs', 'arm64', 'bin', 'npm'));
        expect(paths!.npxPath).toBe(path.join(resourcesPath, 'nodejs', 'arm64', 'bin', 'npx'));
      });

      it('should return correct paths for x64 architecture', async () => {
        // Arrange
        mockApp.isPackaged = true;
        Object.defineProperty(process, 'arch', { value: 'x64' });
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        // Re-import to pick up new process values
        vi.resetModules();
        const module = await import('@main/utils/bundled-node');
        const paths = module.getBundledNodePaths();

        // Assert
        expect(paths).not.toBeNull();
        expect(paths!.nodeDir).toBe(path.join(resourcesPath, 'nodejs', 'x64'));
        expect(paths!.binDir).toBe(path.join(resourcesPath, 'nodejs', 'x64', 'bin'));
      });
    });

    describe('Packaged Mode - Windows (win32)', () => {
      it('should return correct paths for Windows', async () => {
        // Arrange
        mockApp.isPackaged = true;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        Object.defineProperty(process, 'arch', { value: 'x64' });
        const resourcesPath = 'C:\\Program Files\\Accomplish\\resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        // Re-import to pick up new process values
        vi.resetModules();
        const module = await import('@main/utils/bundled-node');
        const paths = module.getBundledNodePaths();

        // Assert
        expect(paths).not.toBeNull();
        expect(paths!.nodeDir).toBe(path.join(resourcesPath, 'nodejs', 'x64'));
        // Windows: binDir is same as nodeDir
        expect(paths!.binDir).toBe(path.join(resourcesPath, 'nodejs', 'x64'));
        expect(paths!.nodePath).toBe(path.join(resourcesPath, 'nodejs', 'x64', 'node.exe'));
        expect(paths!.npmPath).toBe(path.join(resourcesPath, 'nodejs', 'x64', 'npm.cmd'));
        expect(paths!.npxPath).toBe(path.join(resourcesPath, 'nodejs', 'x64', 'npx.cmd'));
      });
    });
  });

  describe('isBundledNodeAvailable()', () => {
    it('should return false in development mode', () => {
      // Arrange
      mockApp.isPackaged = false;

      // Act
      const result = isBundledNodeAvailable();

      // Assert
      expect(result).toBe(false);
    });

    it('should return true when bundled node exists', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(true);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Act
      const result = module.isBundledNodeAvailable();

      // Assert
      expect(result).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalled();
    });

    it('should return false when bundled node does not exist', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(false);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Act
      const result = module.isBundledNodeAvailable();

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('getNodePath()', () => {
    it('should return "node" in development mode', () => {
      // Arrange
      mockApp.isPackaged = false;

      // Act
      const result = getNodePath();

      // Assert
      expect(result).toBe('node');
    });

    it('should return bundled node path when available', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(true);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Act
      const result = module.getNodePath();

      // Assert
      expect(result).toContain('node');
      expect(result).not.toBe('node'); // Should be full path
    });

    it('should fallback to "node" when bundled not found in packaged app', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(false);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Spy on console.warn
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Act
      const result = module.getNodePath();

      // Assert
      expect(result).toBe('node');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Bundled Node.js not found')
      );

      warnSpy.mockRestore();
    });
  });

  describe('getNpmPath()', () => {
    it('should return "npm" in development mode', () => {
      // Arrange
      mockApp.isPackaged = false;

      // Act
      const result = getNpmPath();

      // Assert
      expect(result).toBe('npm');
    });

    it('should return bundled npm path when available', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(true);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Act
      const result = module.getNpmPath();

      // Assert
      expect(result).toContain('npm');
      expect(result).not.toBe('npm'); // Should be full path
    });

    it('should fallback to "npm" when bundled not found', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(false);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Suppress console.warn
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Act
      const result = module.getNpmPath();

      // Assert
      expect(result).toBe('npm');
    });
  });

  describe('getNpxPath()', () => {
    it('should return "npx" in development mode', () => {
      // Arrange
      mockApp.isPackaged = false;

      // Act
      const result = getNpxPath();

      // Assert
      expect(result).toBe('npx');
    });

    it('should return bundled npx path when available', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(true);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Act
      const result = module.getNpxPath();

      // Assert
      expect(result).toContain('npx');
      expect(result).not.toBe('npx'); // Should be full path
    });

    it('should fallback to "npx" when bundled not found', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(false);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Suppress console.warn
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Act
      const result = module.getNpxPath();

      // Assert
      expect(result).toBe('npx');
    });
  });

  describe('logBundledNodeInfo()', () => {
    it('should log development mode message when not packaged', () => {
      // Arrange
      mockApp.isPackaged = false;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act
      logBundledNodeInfo();

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Development mode')
      );

      logSpy.mockRestore();
    });

    it('should log bundled node configuration when packaged', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      mockFs.existsSync.mockReturnValue(true);

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act
      module.logBundledNodeInfo();

      // Assert
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Platform'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Architecture'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Node directory'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Node path'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Available'));

      logSpy.mockRestore();
    });
  });

  describe('BundledNodePaths Interface', () => {
    it('should return all required path properties', async () => {
      // Arrange
      mockApp.isPackaged = true;
      const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

      // Re-import
      vi.resetModules();
      const module = await import('@main/utils/bundled-node');

      // Act
      const paths = module.getBundledNodePaths();

      // Assert
      expect(paths).not.toBeNull();
      expect(paths).toHaveProperty('nodePath');
      expect(paths).toHaveProperty('npmPath');
      expect(paths).toHaveProperty('npxPath');
      expect(paths).toHaveProperty('binDir');
      expect(paths).toHaveProperty('nodeDir');

      // All should be strings
      expect(typeof paths!.nodePath).toBe('string');
      expect(typeof paths!.npmPath).toBe('string');
      expect(typeof paths!.npxPath).toBe('string');
      expect(typeof paths!.binDir).toBe('string');
      expect(typeof paths!.nodeDir).toBe('string');
    });
  });
});
