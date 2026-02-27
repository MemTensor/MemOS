/**
 * Unit tests for Accomplish API library
 *
 * Tests the Electron detection and shell utilities:
 * - isRunningInElectron() detection
 * - getShellVersion() retrieval
 * - getShellPlatform() retrieval
 * - getAccomplish() and useAccomplish() API access
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store original window
const originalWindow = globalThis.window;

describe('Accomplish API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { window: typeof window }).window = originalWindow;
  });

  describe('isRunningInElectron', () => {
    it('should return true when accomplishShell.isElectron is true', async () => {
      (globalThis as unknown as { window: { accomplishShell: { isElectron: boolean } } }).window = {
        accomplishShell: { isElectron: true },
      };

      const { isRunningInElectron } = await import('@renderer/lib/accomplish');
      expect(isRunningInElectron()).toBe(true);
    });

    it('should return false when accomplishShell.isElectron is false', async () => {
      (globalThis as unknown as { window: { accomplishShell: { isElectron: boolean } } }).window = {
        accomplishShell: { isElectron: false },
      };

      const { isRunningInElectron } = await import('@renderer/lib/accomplish');
      expect(isRunningInElectron()).toBe(false);
    });

    it('should return false when accomplishShell is unavailable', async () => {
      // Test undefined, null, missing property, and empty object
      const unavailableScenarios = [
        { accomplishShell: undefined },
        { accomplishShell: null },
        { accomplishShell: { version: '1.0.0' } }, // missing isElectron
        {}, // no accomplishShell at all
      ];

      for (const scenario of unavailableScenarios) {
        vi.resetModules();
        (globalThis as unknown as { window: Record<string, unknown> }).window = scenario;
        const { isRunningInElectron } = await import('@renderer/lib/accomplish');
        expect(isRunningInElectron()).toBe(false);
      }
    });

    it('should use strict equality for isElectron check', async () => {
      // Truthy but not true should return false
      (globalThis as unknown as { window: { accomplishShell: { isElectron: number } } }).window = {
        accomplishShell: { isElectron: 1 },
      };

      const { isRunningInElectron } = await import('@renderer/lib/accomplish');
      expect(isRunningInElectron()).toBe(false);
    });
  });

  describe('getShellVersion', () => {
    it('should return version when available', async () => {
      (globalThis as unknown as { window: { accomplishShell: { version: string } } }).window = {
        accomplishShell: { version: '1.2.3' },
      };

      const { getShellVersion } = await import('@renderer/lib/accomplish');
      expect(getShellVersion()).toBe('1.2.3');
    });

    it('should return null when version is unavailable', async () => {
      const unavailableScenarios = [
        { accomplishShell: undefined },
        { accomplishShell: { isElectron: true } }, // no version property
        {},
      ];

      for (const scenario of unavailableScenarios) {
        vi.resetModules();
        (globalThis as unknown as { window: Record<string, unknown> }).window = scenario;
        const { getShellVersion } = await import('@renderer/lib/accomplish');
        expect(getShellVersion()).toBeNull();
      }
    });

    it('should handle various version formats', async () => {
      const versions = ['0.0.1', '1.0.0', '2.5.10', '1.0.0-beta.1', '1.0.0-rc.2'];

      for (const version of versions) {
        vi.resetModules();
        (globalThis as unknown as { window: { accomplishShell: { version: string } } }).window = {
          accomplishShell: { version },
        };
        const { getShellVersion } = await import('@renderer/lib/accomplish');
        expect(getShellVersion()).toBe(version);
      }
    });
  });

  describe('getShellPlatform', () => {
    it('should return platform when available', async () => {
      const platforms = ['darwin', 'linux', 'win32'];

      for (const platform of platforms) {
        vi.resetModules();
        (globalThis as unknown as { window: { accomplishShell: { platform: string } } }).window = {
          accomplishShell: { platform },
        };
        const { getShellPlatform } = await import('@renderer/lib/accomplish');
        expect(getShellPlatform()).toBe(platform);
      }
    });

    it('should return null when platform is unavailable', async () => {
      const unavailableScenarios = [
        { accomplishShell: undefined },
        { accomplishShell: { isElectron: true } }, // no platform property
        {},
      ];

      for (const scenario of unavailableScenarios) {
        vi.resetModules();
        (globalThis as unknown as { window: Record<string, unknown> }).window = scenario;
        const { getShellPlatform } = await import('@renderer/lib/accomplish');
        expect(getShellPlatform()).toBeNull();
      }
    });
  });

  describe('getAccomplish', () => {
    it('should return accomplish API when available', async () => {
      const mockApi = {
        getVersion: vi.fn(),
        startTask: vi.fn(),
        validateBedrockCredentials: vi.fn(),
        saveBedrockCredentials: vi.fn(),
        getBedrockCredentials: vi.fn(),
      };
      (globalThis as unknown as { window: { accomplish: typeof mockApi } }).window = {
        accomplish: mockApi,
      };

      const { getAccomplish } = await import('@renderer/lib/accomplish');
      const result = getAccomplish();
      // getAccomplish returns a wrapper object with spread methods + Bedrock wrappers
      expect(result.getVersion).toBeDefined();
      expect(result.startTask).toBeDefined();
      expect(result.validateBedrockCredentials).toBeDefined();
      expect(result.saveBedrockCredentials).toBeDefined();
      expect(result.getBedrockCredentials).toBeDefined();
    });

    it('should throw when accomplish API is not available', async () => {
      const unavailableScenarios = [
        { accomplish: undefined },
        {},
      ];

      for (const scenario of unavailableScenarios) {
        vi.resetModules();
        (globalThis as unknown as { window: Record<string, unknown> }).window = scenario;
        const { getAccomplish } = await import('@renderer/lib/accomplish');
        expect(() => getAccomplish()).toThrow('Accomplish API not available - not running in Electron');
      }
    });
  });

  describe('useAccomplish', () => {
    it('should return accomplish API when available', async () => {
      const mockApi = { getVersion: vi.fn(), startTask: vi.fn() };
      (globalThis as unknown as { window: { accomplish: typeof mockApi } }).window = {
        accomplish: mockApi,
      };

      const { useAccomplish } = await import('@renderer/lib/accomplish');
      expect(useAccomplish()).toBe(mockApi);
    });

    it('should throw when accomplish API is not available', async () => {
      (globalThis as unknown as { window: { accomplish?: unknown } }).window = {
        accomplish: undefined,
      };

      const { useAccomplish } = await import('@renderer/lib/accomplish');
      expect(() => useAccomplish()).toThrow('Accomplish API not available - not running in Electron');
    });
  });

  describe('Complete Shell Object', () => {
    it('should recognize complete shell object with all properties', async () => {
      const completeShell = {
        version: '1.0.0',
        platform: 'darwin',
        isElectron: true as const,
      };
      (globalThis as unknown as { window: { accomplishShell: typeof completeShell } }).window = {
        accomplishShell: completeShell,
      };

      const { isRunningInElectron, getShellVersion, getShellPlatform } = await import('@renderer/lib/accomplish');

      expect(isRunningInElectron()).toBe(true);
      expect(getShellVersion()).toBe('1.0.0');
      expect(getShellPlatform()).toBe('darwin');
    });

    it('should handle partial shell object gracefully', async () => {
      const partialShell = { version: '1.0.0', isElectron: true as const };
      (globalThis as unknown as { window: { accomplishShell: typeof partialShell } }).window = {
        accomplishShell: partialShell,
      };

      const { isRunningInElectron, getShellVersion, getShellPlatform } = await import('@renderer/lib/accomplish');

      expect(isRunningInElectron()).toBe(true);
      expect(getShellVersion()).toBe('1.0.0');
      expect(getShellPlatform()).toBeNull();
    });
  });
});
