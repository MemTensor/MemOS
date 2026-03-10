import { test, expect } from '../fixtures';
import { SettingsPage } from '../pages';
import { captureForAI } from '../utils';
import { TEST_TIMEOUTS } from '../config';

/**
 * Comprehensive E2E tests for all provider settings permutations
 *
 * Provider order (4 columns per row):
 * Row 1: Anthropic, OpenAI, Google (Gemini), xAI
 * Row 2: DeepSeek, Z-AI, Ollama, Bedrock
 * Row 3: OpenRouter, LiteLLM
 */
test.describe('Settings - All Providers', () => {
  // ===== GOOGLE (GEMINI) PROVIDER =====
  test.describe('Google (Gemini) Provider', () => {
    test('should display Google provider card in first row', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // Google is in first 4, should be visible without Show All
      const googleCard = settingsPage.getProviderCard('google');
      await expect(googleCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

      await captureForAI(window, 'settings-google', 'provider-card-visible', [
        'Google (Gemini) provider card is visible',
        'Card is in first row (no Show All needed)',
      ]);
    });

    test('should show API key form when selecting Google', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('google');
      await expect(settingsPage.apiKeyInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

      await captureForAI(window, 'settings-google', 'api-key-form', [
        'Google API key input is visible',
        'User can enter Gemini API key',
      ]);
    });

    test('should allow typing Google API key', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('google');
      const testKey = 'AIzaSyTest_GoogleKey_12345';
      await settingsPage.apiKeyInput.fill(testKey);

      await expect(settingsPage.apiKeyInput).toHaveValue(testKey);

      await captureForAI(window, 'settings-google', 'api-key-filled', [
        'Google API key input accepts value',
        'Key format is displayed correctly',
      ]);
    });
  });

  // ===== XAI PROVIDER =====
  test.describe('xAI Provider', () => {
    test('should display xAI provider card in first row', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // xAI is in first 4, should be visible without Show All
      const xaiCard = settingsPage.getProviderCard('xai');
      await expect(xaiCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

      await captureForAI(window, 'settings-xai', 'provider-card-visible', [
        'xAI provider card is visible',
        'Card is in first row (no Show All needed)',
      ]);
    });

    test('should show API key form when selecting xAI', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('xai');

      await expect(settingsPage.apiKeyInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

      await captureForAI(window, 'settings-xai', 'api-key-form', [
        'xAI API key input is visible',
        'User can enter xAI API key',
      ]);
    });

    test('should allow typing xAI API key', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('xai');

      const testKey = 'xai-test-key-67890';
      await settingsPage.apiKeyInput.fill(testKey);

      await expect(settingsPage.apiKeyInput).toHaveValue(testKey);

      await captureForAI(window, 'settings-xai', 'api-key-filled', [
        'xAI API key input accepts value',
        'Key format is displayed correctly',
      ]);
    });
  });

  // ===== OPENAI PROVIDER =====
  test.describe('OpenAI Provider', () => {
    test('should display OpenAI provider card in first row', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // OpenAI is in first 4
      const openaiCard = settingsPage.getProviderCard('openai');
      await expect(openaiCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

      await captureForAI(window, 'settings-openai', 'provider-card-visible', [
        'OpenAI provider card is visible',
        'Card is in first row',
      ]);
    });

    test('should show API key form when selecting OpenAI', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('openai');
      await expect(settingsPage.apiKeyInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

      await captureForAI(window, 'settings-openai', 'api-key-form', [
        'OpenAI API key input is visible',
      ]);
    });

    test('should allow typing OpenAI API key', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('openai');
      const testKey = 'sk-test-openai-key-12345';
      await settingsPage.apiKeyInput.fill(testKey);

      await expect(settingsPage.apiKeyInput).toHaveValue(testKey);

      await captureForAI(window, 'settings-openai', 'api-key-filled', [
        'OpenAI API key input accepts value',
      ]);
    });
  });

  // ===== GRID LAYOUT TESTS =====
  test.describe('Provider Grid Layout', () => {
    test('should display 4 providers in collapsed view', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // First 4 providers should be visible
      await expect(settingsPage.getProviderCard('anthropic')).toBeVisible();
      await expect(settingsPage.getProviderCard('openai')).toBeVisible();
      await expect(settingsPage.getProviderCard('google')).toBeVisible();
      await expect(settingsPage.getProviderCard('xai')).toBeVisible();

      // 5th provider (deepseek) should NOT be visible in collapsed view
      await expect(settingsPage.getProviderCard('deepseek')).not.toBeVisible();

      await captureForAI(window, 'settings-grid', 'collapsed-view', [
        'First 4 providers visible in collapsed view',
        'Grid uses 4-column layout',
      ]);
    });

    test('should expand to show all 10 providers', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.toggleShowAll();

      // All 10 providers should be visible
      const allProviders = [
        'anthropic', 'openai', 'google', 'xai',
        'deepseek', 'zai', 'ollama', 'bedrock',
        'openrouter', 'litellm'
      ];

      for (const providerId of allProviders) {
        await expect(settingsPage.getProviderCard(providerId)).toBeVisible();
      }

      await captureForAI(window, 'settings-grid', 'expanded-view', [
        'All 10 providers visible in expanded view',
        'Grid shows 3 rows of providers',
      ]);
    });

    test('should toggle between Show All and Hide', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // Initial state - Show All button visible
      await expect(settingsPage.showAllButton).toBeVisible();

      // Click Show All
      await settingsPage.toggleShowAll();
      await expect(settingsPage.hideButton).toBeVisible();

      // Click Hide
      await settingsPage.toggleShowAll();
      await expect(settingsPage.showAllButton).toBeVisible();

      // DeepSeek should be hidden again (5th provider)
      await expect(settingsPage.getProviderCard('deepseek')).not.toBeVisible();

      await captureForAI(window, 'settings-grid', 'toggle-behavior', [
        'Show All/Hide toggle works correctly',
        'Grid collapses back to 4 providers',
      ]);
    });
  });

  // ===== PROVIDER SELECTION FLOW =====
  test.describe('Provider Selection Flow', () => {
    test('should switch between providers in first row', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // Select Anthropic
      await settingsPage.selectProvider('anthropic');
      await expect(settingsPage.apiKeyInput).toBeVisible();

      // Switch to OpenAI
      await settingsPage.selectProvider('openai');
      await expect(settingsPage.apiKeyInput).toBeVisible();

      // Switch to Google
      await settingsPage.selectProvider('google');
      await expect(settingsPage.apiKeyInput).toBeVisible();

      await captureForAI(window, 'settings-selection', 'switch-providers', [
        'Can switch between providers',
        'Settings panel updates for each provider',
      ]);
    });

    test('should switch from classic provider to custom provider', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // Select Anthropic (classic API key provider)
      await settingsPage.selectProvider('anthropic');
      await expect(settingsPage.apiKeyInput).toBeVisible();

      // Expand and switch to Ollama (URL-based provider)
      await settingsPage.toggleShowAll();
      await settingsPage.selectProvider('ollama');
      await expect(settingsPage.ollamaServerUrlInput).toBeVisible();

      // API key input should not be visible for Ollama
      await expect(settingsPage.apiKeyInput).not.toBeVisible();

      await captureForAI(window, 'settings-selection', 'switch-provider-types', [
        'Can switch from API key to URL-based provider',
        'Form updates correctly for different provider types',
      ]);
    });

    test('should switch from URL provider back to classic provider', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      // Expand and select Ollama first
      await settingsPage.toggleShowAll();
      await settingsPage.selectProvider('ollama');
      await expect(settingsPage.ollamaServerUrlInput).toBeVisible();

      // Switch back to Anthropic
      await settingsPage.selectProvider('anthropic');
      await expect(settingsPage.apiKeyInput).toBeVisible();

      // Ollama URL should not be visible
      await expect(settingsPage.ollamaServerUrlInput).not.toBeVisible();

      await captureForAI(window, 'settings-selection', 'switch-back-to-classic', [
        'Can switch from URL provider back to classic',
        'Form updates correctly',
      ]);
    });
  });

  // ===== PROVIDER SETTINGS PANEL =====
  test.describe('Provider Settings Panel', () => {
    test('should display provider header with logo and name', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('anthropic');

      // Verify settings panel is visible
      const settingsPanel = window.getByTestId('provider-settings-panel');
      await expect(settingsPanel).toBeVisible();

      await captureForAI(window, 'settings-panel', 'header-visible', [
        'Provider settings panel is visible',
        'Header shows provider logo and name',
      ]);
    });

    test('should show Connect button when not connected', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('anthropic');
      await expect(settingsPage.connectButton).toBeVisible();

      await captureForAI(window, 'settings-panel', 'connect-button', [
        'Connect button is visible for disconnected provider',
      ]);
    });

    test('should show help link for API key providers', async ({ window }) => {
      const settingsPage = new SettingsPage(window);
      await window.waitForLoadState('domcontentloaded');
      await settingsPage.navigateToSettings();

      await settingsPage.selectProvider('anthropic');
      await expect(settingsPage.apiKeyHelpLink).toBeVisible();

      await captureForAI(window, 'settings-panel', 'help-link', [
        'Help link "How can I find it?" is visible',
      ]);
    });
  });
});
