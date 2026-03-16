/**
 * Integration tests for appSettings store
 * Tests real electron-store interactions with temporary directories
 * @module __tests__/integration/main/appSettings.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create a unique temp directory for each test run
let tempDir: string;
let originalCwd: string;

describe('appSettings Integration', () => {
  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appSettings-test-'));
    originalCwd = process.cwd();

    // Reset module cache first
    vi.resetModules();

    // Use doMock (not hoisted) so tempDir is captured with current value
    vi.doMock('electron', () => ({
      app: {
        getPath: (name: string) => {
          if (name === 'userData') {
            return tempDir;
          }
          return `/mock/path/${name}`;
        },
        getVersion: () => '0.1.0',
        getName: () => 'Accomplish',
        isPackaged: false,
      },
    }));
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    process.chdir(originalCwd);
  });

  describe('debugMode', () => {
    it('should return false as default value for debugMode', async () => {
      // Arrange
      const { getDebugMode, clearAppSettings } = await import('@main/store/appSettings');
      clearAppSettings(); // Ensure fresh state

      // Act
      const result = getDebugMode();

      // Assert
      expect(result).toBe(false);
    });

    it('should persist debugMode after setting to true', async () => {
      // Arrange
      const { getDebugMode, setDebugMode } = await import('@main/store/appSettings');

      // Act
      setDebugMode(true);
      const result = getDebugMode();

      // Assert
      expect(result).toBe(true);
    });

    it('should persist debugMode after setting to false', async () => {
      // Arrange
      const { getDebugMode, setDebugMode } = await import('@main/store/appSettings');

      // Act - set to true first, then false
      setDebugMode(true);
      setDebugMode(false);
      const result = getDebugMode();

      // Assert
      expect(result).toBe(false);
    });

    it('should round-trip debugMode value correctly', async () => {
      // Arrange
      const { getDebugMode, setDebugMode } = await import('@main/store/appSettings');

      // Act
      setDebugMode(true);
      const afterTrue = getDebugMode();
      setDebugMode(false);
      const afterFalse = getDebugMode();
      setDebugMode(true);
      const afterTrueAgain = getDebugMode();

      // Assert
      expect(afterTrue).toBe(true);
      expect(afterFalse).toBe(false);
      expect(afterTrueAgain).toBe(true);
    });
  });

  describe('onboardingComplete', () => {
    it('should return false as default value for onboardingComplete', async () => {
      // Arrange
      const { getOnboardingComplete, clearAppSettings } = await import('@main/store/appSettings');
      clearAppSettings(); // Ensure fresh state

      // Act
      const result = getOnboardingComplete();

      // Assert
      expect(result).toBe(false);
    });

    it('should persist onboardingComplete after setting to true', async () => {
      // Arrange
      const { getOnboardingComplete, setOnboardingComplete } = await import('@main/store/appSettings');

      // Act
      setOnboardingComplete(true);
      const result = getOnboardingComplete();

      // Assert
      expect(result).toBe(true);
    });

    it('should round-trip onboardingComplete value correctly', async () => {
      // Arrange
      const { getOnboardingComplete, setOnboardingComplete } = await import('@main/store/appSettings');

      // Act
      setOnboardingComplete(true);
      const afterTrue = getOnboardingComplete();
      setOnboardingComplete(false);
      const afterFalse = getOnboardingComplete();

      // Assert
      expect(afterTrue).toBe(true);
      expect(afterFalse).toBe(false);
    });
  });

  describe('selectedModel', () => {
    it('should return default model on fresh store', async () => {
      // Arrange
      const { getSelectedModel, clearAppSettings } = await import('@main/store/appSettings');
      clearAppSettings(); // Ensure fresh state

      // Act
      const result = getSelectedModel();

      // Assert
      expect(result).toEqual({
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4-5',
      });
    });

    it('should persist selectedModel after setting new value', async () => {
      // Arrange
      const { getSelectedModel, setSelectedModel } = await import('@main/store/appSettings');
      const newModel = { provider: 'openai', model: 'gpt-4' };

      // Act
      setSelectedModel(newModel);
      const result = getSelectedModel();

      // Assert
      expect(result).toEqual(newModel);
    });

    it('should round-trip different model values correctly', async () => {
      // Arrange
      const { getSelectedModel, setSelectedModel } = await import('@main/store/appSettings');
      const model1 = { provider: 'anthropic', model: 'claude-3-opus' };
      const model2 = { provider: 'google', model: 'gemini-pro' };
      const model3 = { provider: 'xai', model: 'grok-4' };

      // Act & Assert
      setSelectedModel(model1);
      expect(getSelectedModel()).toEqual(model1);

      setSelectedModel(model2);
      expect(getSelectedModel()).toEqual(model2);

      setSelectedModel(model3);
      expect(getSelectedModel()).toEqual(model3);
    });
  });

  describe('getAppSettings', () => {
    it('should return all default settings on fresh store', async () => {
      // Arrange
      const { getAppSettings, clearAppSettings } = await import('@main/store/appSettings');
      clearAppSettings(); // Ensure fresh state

      // Act
      const result = getAppSettings();

      // Assert
      expect(result).toEqual({
        debugMode: false,
        onboardingComplete: false,
        ollamaConfig: null,
        litellmConfig: null,
        selectedModel: {
          provider: 'anthropic',
          model: 'anthropic/claude-opus-4-5',
        },
      });
    });

    it('should return all settings after modifications', async () => {
      // Arrange
      const { getAppSettings, setDebugMode, setOnboardingComplete, setSelectedModel, clearAppSettings } = await import('@main/store/appSettings');
      clearAppSettings(); // Start fresh
      const customModel = { provider: 'openai', model: 'gpt-4-turbo' };

      // Act
      setDebugMode(true);
      setOnboardingComplete(true);
      setSelectedModel(customModel);
      const result = getAppSettings();

      // Assert
      expect(result).toEqual({
        debugMode: true,
        onboardingComplete: true,
        ollamaConfig: null,
        litellmConfig: null,
        selectedModel: customModel,
      });
    });

    it('should reflect partial modifications correctly', async () => {
      // Arrange
      const { getAppSettings, setDebugMode, clearAppSettings } = await import('@main/store/appSettings');
      clearAppSettings(); // Start fresh

      // Act - only modify debugMode
      setDebugMode(true);
      const result = getAppSettings();

      // Assert
      expect(result.debugMode).toBe(true);
      expect(result.onboardingComplete).toBe(false);
      expect(result.selectedModel).toEqual({
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4-5',
      });
    });
  });

  describe('clearAppSettings', () => {
    it('should reset all settings to defaults', async () => {
      // Arrange
      const {
        getAppSettings,
        clearAppSettings,
        setDebugMode,
        setOnboardingComplete,
        setSelectedModel
      } = await import('@main/store/appSettings');

      // Set custom values
      setDebugMode(true);
      setOnboardingComplete(true);
      setSelectedModel({ provider: 'openai', model: 'gpt-4' });

      // Act
      clearAppSettings();
      const result = getAppSettings();

      // Assert
      expect(result).toEqual({
        debugMode: false,
        onboardingComplete: false,
        ollamaConfig: null,
        litellmConfig: null,
        selectedModel: {
          provider: 'anthropic',
          model: 'anthropic/claude-opus-4-5',
        },
      });
    });

    it('should reset debugMode to default after clear', async () => {
      // Arrange
      const { getDebugMode, setDebugMode, clearAppSettings } = await import('@main/store/appSettings');

      // Act
      setDebugMode(true);
      expect(getDebugMode()).toBe(true);
      clearAppSettings();
      const result = getDebugMode();

      // Assert
      expect(result).toBe(false);
    });

    it('should reset onboardingComplete to default after clear', async () => {
      // Arrange
      const { getOnboardingComplete, setOnboardingComplete, clearAppSettings } = await import('@main/store/appSettings');

      // Act
      setOnboardingComplete(true);
      expect(getOnboardingComplete()).toBe(true);
      clearAppSettings();
      const result = getOnboardingComplete();

      // Assert
      expect(result).toBe(false);
    });

    it('should reset selectedModel to default after clear', async () => {
      // Arrange
      const { getSelectedModel, setSelectedModel, clearAppSettings } = await import('@main/store/appSettings');

      // Act
      setSelectedModel({ provider: 'openai', model: 'gpt-4' });
      expect(getSelectedModel()).toEqual({ provider: 'openai', model: 'gpt-4' });
      clearAppSettings();
      const result = getSelectedModel();

      // Assert
      expect(result).toEqual({
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4-5',
      });
    });

    it('should allow setting new values after clear', async () => {
      // Arrange
      const { getDebugMode, setDebugMode, clearAppSettings } = await import('@main/store/appSettings');

      // Act
      setDebugMode(true);
      clearAppSettings();
      setDebugMode(true);
      const result = getDebugMode();

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('persistence across module reloads', () => {
    it('should persist values to disk and survive module reload', async () => {
      // Arrange - first import and set values
      const module1 = await import('@main/store/appSettings');
      module1.setDebugMode(true);
      module1.setOnboardingComplete(true);
      module1.setSelectedModel({ provider: 'google', model: 'gemini-ultra' });

      // Act - reset modules and reimport
      vi.resetModules();
      const module2 = await import('@main/store/appSettings');

      // Assert - values should be persisted
      expect(module2.getDebugMode()).toBe(true);
      expect(module2.getOnboardingComplete()).toBe(true);
      expect(module2.getSelectedModel()).toEqual({ provider: 'google', model: 'gemini-ultra' });
    });
  });
});
