import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to test the module in isolation, so we'll import it dynamically
// to reset the cache between tests

describe('config.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    // Clear module cache to reset cachedConfig
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  describe('getDesktopConfig()', () => {
    describe('default configuration', () => {
      it('should return default API URL when ACCOMPLISH_API_URL is not set', async () => {
        // Arrange
        delete process.env.ACCOMPLISH_API_URL;

        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(config.apiUrl).toBe('https://lite.accomplish.ai');
      });

      it('should return default API URL when ACCOMPLISH_API_URL is undefined', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = undefined;

        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(config.apiUrl).toBe('https://lite.accomplish.ai');
      });
    });

    describe('custom API URL parsing', () => {
      it('should use custom HTTPS API URL from environment', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'https://custom.example.com';

        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(config.apiUrl).toBe('https://custom.example.com');
      });

      it('should use custom HTTP API URL from environment', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'http://localhost:3000';

        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(config.apiUrl).toBe('http://localhost:3000');
      });

      it('should accept URL with path', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'https://api.example.com/v1';

        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(config.apiUrl).toBe('https://api.example.com/v1');
      });

      it('should accept URL with port', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'https://api.example.com:8443';

        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(config.apiUrl).toBe('https://api.example.com:8443');
      });

      it('should throw error for invalid URL format', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'not-a-url';

        // Act & Assert
        const { getDesktopConfig } = await import('../../src/main/config');
        expect(() => getDesktopConfig()).toThrow('Invalid desktop configuration');
      });

      it('should throw error for URL without protocol', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'example.com';

        // Act & Assert
        const { getDesktopConfig } = await import('../../src/main/config');
        expect(() => getDesktopConfig()).toThrow('Invalid desktop configuration');
      });

      it('should throw error for empty string URL (invalid url)', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = '';

        // Act & Assert
        // Empty string is an invalid URL and throws an error
        const { getDesktopConfig } = await import('../../src/main/config');
        expect(() => getDesktopConfig()).toThrow('Invalid desktop configuration');
      });
    });

    describe('config caching behavior', () => {
      it('should cache config and return same result on multiple calls', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'https://first.example.com';
        const { getDesktopConfig } = await import('../../src/main/config');

        // Act
        const config1 = getDesktopConfig();

        // Change env after first call
        process.env.ACCOMPLISH_API_URL = 'https://second.example.com';
        const config2 = getDesktopConfig();

        // Assert - should return cached value
        expect(config1).toBe(config2);
        expect(config1.apiUrl).toBe('https://first.example.com');
      });

      it('should return identical object reference from cache', async () => {
        // Arrange
        const { getDesktopConfig } = await import('../../src/main/config');

        // Act
        const config1 = getDesktopConfig();
        const config2 = getDesktopConfig();

        // Assert
        expect(config1).toBe(config2);
      });

      it('should reset cache when module is reloaded', async () => {
        // Arrange
        process.env.ACCOMPLISH_API_URL = 'https://first.example.com';
        const mod1 = await import('../../src/main/config');
        const config1 = mod1.getDesktopConfig();

        // Reset modules and change env
        vi.resetModules();
        process.env.ACCOMPLISH_API_URL = 'https://second.example.com';

        // Act
        const mod2 = await import('../../src/main/config');
        const config2 = mod2.getDesktopConfig();

        // Assert
        expect(config1.apiUrl).toBe('https://first.example.com');
        expect(config2.apiUrl).toBe('https://second.example.com');
      });
    });

    describe('config structure', () => {
      it('should return object with apiUrl property', async () => {
        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(config).toHaveProperty('apiUrl');
        expect(typeof config.apiUrl).toBe('string');
      });

      it('should not have extra properties beyond apiUrl', async () => {
        // Act
        const { getDesktopConfig } = await import('../../src/main/config');
        const config = getDesktopConfig();

        // Assert
        expect(Object.keys(config)).toEqual(['apiUrl']);
      });
    });
  });
});
