/**
 * Integration tests for OpenCode CLI path resolution
 *
 * Tests the cli-path module which resolves paths to the OpenCode CLI binary
 * in both development and packaged app modes.
 *
 * @module __tests__/integration/main/opencode/cli-path.integration.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'path';

// Mock electron module before importing the module under test
const mockApp = {
  isPackaged: false,
  getAppPath: vi.fn(() => '/mock/app/path'),
};

vi.mock('electron', () => ({
  app: mockApp,
}));

// Mock fs module
const mockFs = {
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
};

vi.mock('fs', () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
  readdirSync: mockFs.readdirSync,
  readFileSync: mockFs.readFileSync,
}));

// Mock child_process
const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

describe('OpenCode CLI Path Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state
    vi.resetModules();
    // Reset packaged state
    mockApp.isPackaged = false;
    // Reset HOME environment variable
    process.env.HOME = '/Users/testuser';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getOpenCodeCliPath()', () => {
    describe('Development Mode', () => {
      it('should return nvm OpenCode path when available', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const nvmVersionsDir = '/Users/testuser/.nvm/versions/node';
        const expectedPath = path.join(nvmVersionsDir, 'v20.10.0', 'bin', 'opencode');

        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === nvmVersionsDir) return true;
          if (p === expectedPath) return true;
          return false;
        });
        mockFs.readdirSync.mockImplementation((p: string) => {
          if (p === nvmVersionsDir) return ['v20.10.0'];
          return [];
        });

        // Act
        const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
        const result = getOpenCodeCliPath();

        // Assert
        expect(result.command).toBe(expectedPath);
        expect(result.args).toEqual([]);
      });

      it('should return global npm OpenCode path when nvm not available', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const globalPath = '/usr/local/bin/opencode';

        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === globalPath) return true;
          return false;
        });
        mockFs.readdirSync.mockReturnValue([]);

        // Act
        const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
        const result = getOpenCodeCliPath();

        // Assert
        expect(result.command).toBe(globalPath);
        expect(result.args).toEqual([]);
      });

      it('should return Homebrew OpenCode path on Apple Silicon', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const homebrewPath = '/opt/homebrew/bin/opencode';

        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === homebrewPath) return true;
          return false;
        });
        mockFs.readdirSync.mockReturnValue([]);

        // Act
        const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
        const result = getOpenCodeCliPath();

        // Assert
        expect(result.command).toBe(homebrewPath);
        expect(result.args).toEqual([]);
      });

      it('should return bundled CLI path in node_modules when global not found', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const appPath = '/mock/app/path';
        const bundledPath = path.join(appPath, 'node_modules', '.bin', 'opencode');

        mockApp.getAppPath.mockReturnValue(appPath);
        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === bundledPath) return true;
          return false;
        });
        mockFs.readdirSync.mockReturnValue([]);

        // Act
        const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
        const result = getOpenCodeCliPath();

        // Assert
        expect(result.command).toBe(bundledPath);
        expect(result.args).toEqual([]);
      });

      it('should fallback to PATH-based opencode when no paths found', async () => {
        // Arrange
        mockApp.isPackaged = false;
        mockFs.existsSync.mockReturnValue(false);
        mockFs.readdirSync.mockReturnValue([]);

        // Act
        const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
        const result = getOpenCodeCliPath();

        // Assert
        expect(result.command).toBe('opencode');
        expect(result.args).toEqual([]);
      });
    });

    describe('Packaged Mode', () => {
      it('should return unpacked asar path when packaged', async () => {
        // Arrange
        mockApp.isPackaged = true;
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        const expectedPath = path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'opencode-ai',
          'bin',
          'opencode'
        );

        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === expectedPath) return true;
          return false;
        });

        // Act
        const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
        const result = getOpenCodeCliPath();

        // Assert
        expect(result.command).toBe(expectedPath);
        expect(result.args).toEqual([]);
      });

      it('should throw error when bundled CLI not found in packaged app', async () => {
        // Arrange
        mockApp.isPackaged = true;
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        mockFs.existsSync.mockReturnValue(false);

        // Act & Assert
        const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
        expect(() => getOpenCodeCliPath()).toThrow('OpenCode CLI not found at');
      });
    });
  });

  describe('isOpenCodeBundled()', () => {
    describe('Development Mode', () => {
      it('should return true when nvm OpenCode is available', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const nvmVersionsDir = '/Users/testuser/.nvm/versions/node';
        const opencodePath = path.join(nvmVersionsDir, 'v20.10.0', 'bin', 'opencode');

        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === nvmVersionsDir) return true;
          if (p === opencodePath) return true;
          return false;
        });
        mockFs.readdirSync.mockImplementation((p: string) => {
          if (p === nvmVersionsDir) return ['v20.10.0'];
          return [];
        });

        // Act
        const { isOpenCodeBundled } = await import('@main/opencode/cli-path');
        const result = isOpenCodeBundled();

        // Assert
        expect(result).toBe(true);
      });

      it('should return true when bundled CLI exists in node_modules', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const appPath = '/mock/app/path';
        const bundledPath = path.join(appPath, 'node_modules', '.bin', 'opencode');

        mockApp.getAppPath.mockReturnValue(appPath);
        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === bundledPath) return true;
          return false;
        });
        mockFs.readdirSync.mockReturnValue([]);

        // Act
        const { isOpenCodeBundled } = await import('@main/opencode/cli-path');
        const result = isOpenCodeBundled();

        // Assert
        expect(result).toBe(true);
      });

      it('should return true when opencode is available on PATH', async () => {
        // Arrange
        mockApp.isPackaged = false;
        mockFs.existsSync.mockReturnValue(false);
        mockFs.readdirSync.mockReturnValue([]);
        mockExecSync.mockReturnValue('/usr/local/bin/opencode');

        // Act
        const { isOpenCodeBundled } = await import('@main/opencode/cli-path');
        const result = isOpenCodeBundled();

        // Assert
        expect(result).toBe(true);
      });

      it('should return false when no CLI is found anywhere', async () => {
        // Arrange
        mockApp.isPackaged = false;
        mockFs.existsSync.mockReturnValue(false);
        mockFs.readdirSync.mockReturnValue([]);
        mockExecSync.mockImplementation(() => {
          throw new Error('Command not found');
        });

        // Act
        const { isOpenCodeBundled } = await import('@main/opencode/cli-path');
        const result = isOpenCodeBundled();

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('Packaged Mode', () => {
      it('should return true when bundled CLI exists in unpacked asar', async () => {
        // Arrange
        mockApp.isPackaged = true;
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        const cliPath = path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'opencode-ai',
          'bin',
          'opencode'
        );

        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === cliPath) return true;
          return false;
        });

        // Act
        const { isOpenCodeBundled } = await import('@main/opencode/cli-path');
        const result = isOpenCodeBundled();

        // Assert
        expect(result).toBe(true);
      });

      it('should return false when bundled CLI missing in unpacked asar', async () => {
        // Arrange
        mockApp.isPackaged = true;
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        mockFs.existsSync.mockReturnValue(false);

        // Act
        const { isOpenCodeBundled } = await import('@main/opencode/cli-path');
        const result = isOpenCodeBundled();

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('getBundledOpenCodeVersion()', () => {
    describe('Packaged Mode', () => {
      it('should read version from package.json in unpacked asar', async () => {
        // Arrange
        mockApp.isPackaged = true;
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        const packageJsonPath = path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'opencode-ai',
          'package.json'
        );

        mockFs.existsSync.mockImplementation((p: string) => p === packageJsonPath);
        mockFs.readFileSync.mockImplementation((p: string) => {
          if (p === packageJsonPath) {
            return JSON.stringify({ version: '1.2.3' });
          }
          return '';
        });

        // Act
        const { getBundledOpenCodeVersion } = await import('@main/opencode/cli-path');
        const result = getBundledOpenCodeVersion();

        // Assert
        expect(result).toBe('1.2.3');
      });

      it('should return null when package.json not found', async () => {
        // Arrange
        mockApp.isPackaged = true;
        const resourcesPath = '/Applications/Accomplish.app/Contents/Resources';
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        mockFs.existsSync.mockReturnValue(false);

        // Act
        const { getBundledOpenCodeVersion } = await import('@main/opencode/cli-path');
        const result = getBundledOpenCodeVersion();

        // Assert
        expect(result).toBeNull();
      });
    });

    describe('Development Mode', () => {
      it('should execute CLI with --version flag and parse output', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const appPath = '/mock/app/path';
        const bundledPath = path.join(appPath, 'node_modules', '.bin', 'opencode');

        mockApp.getAppPath.mockReturnValue(appPath);
        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === bundledPath) return true;
          return false;
        });
        mockFs.readdirSync.mockReturnValue([]);
        mockExecSync.mockReturnValue('opencode 1.5.0\n');

        // Act
        const { getBundledOpenCodeVersion } = await import('@main/opencode/cli-path');
        const result = getBundledOpenCodeVersion();

        // Assert
        expect(result).toBe('1.5.0');
      });

      it('should parse version from simple version string', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const appPath = '/mock/app/path';
        const bundledPath = path.join(appPath, 'node_modules', '.bin', 'opencode');

        mockApp.getAppPath.mockReturnValue(appPath);
        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === bundledPath) return true;
          return false;
        });
        mockFs.readdirSync.mockReturnValue([]);
        mockExecSync.mockReturnValue('2.0.1');

        // Act
        const { getBundledOpenCodeVersion } = await import('@main/opencode/cli-path');
        const result = getBundledOpenCodeVersion();

        // Assert
        expect(result).toBe('2.0.1');
      });

      it('should return null when version command fails', async () => {
        // Arrange
        mockApp.isPackaged = false;
        const appPath = '/mock/app/path';
        const bundledPath = path.join(appPath, 'node_modules', '.bin', 'opencode');

        mockApp.getAppPath.mockReturnValue(appPath);
        mockFs.existsSync.mockImplementation((p: string) => {
          if (p === bundledPath) return true;
          return false;
        });
        mockFs.readdirSync.mockReturnValue([]);
        mockExecSync.mockImplementation(() => {
          throw new Error('Command failed');
        });

        // Act
        const { getBundledOpenCodeVersion } = await import('@main/opencode/cli-path');
        const result = getBundledOpenCodeVersion();

        // Assert
        expect(result).toBeNull();
      });
    });
  });

  describe('NVM Path Scanning', () => {
    it('should scan multiple nvm versions and return first found', async () => {
      // Arrange
      mockApp.isPackaged = false;
      const nvmVersionsDir = '/Users/testuser/.nvm/versions/node';
      const v18Path = path.join(nvmVersionsDir, 'v18.17.0', 'bin', 'opencode');
      const v20Path = path.join(nvmVersionsDir, 'v20.10.0', 'bin', 'opencode');

      mockFs.existsSync.mockImplementation((p: string) => {
        if (p === nvmVersionsDir) return true;
        if (p === v20Path) return true;
        if (p === v18Path) return false;
        return false;
      });
      mockFs.readdirSync.mockImplementation((p: string) => {
        if (p === nvmVersionsDir) return ['v18.17.0', 'v20.10.0'];
        return [];
      });

      // Act
      const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
      const result = getOpenCodeCliPath();

      // Assert
      expect(result.command).toBe(v20Path);
    });

    it('should handle missing nvm directory gracefully', async () => {
      // Arrange
      mockApp.isPackaged = false;
      process.env.HOME = '/Users/testuser';

      mockFs.existsSync.mockReturnValue(false);
      mockFs.readdirSync.mockReturnValue([]);

      // Act
      const { getOpenCodeCliPath } = await import('@main/opencode/cli-path');
      const result = getOpenCodeCliPath();

      // Assert - should fallback to opencode on PATH
      expect(result.command).toBe('opencode');
    });
  });
});
