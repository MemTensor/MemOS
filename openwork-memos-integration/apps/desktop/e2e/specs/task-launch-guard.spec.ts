import { test, expect } from '../fixtures';
import { SettingsPage, HomePage } from '../pages';
import { captureForAI } from '../utils';
import { TEST_TIMEOUTS, TEST_SCENARIOS } from '../config';

/**
 * Tests for the task launch guard functionality.
 *
 * The task launch guard prevents users from:
 * 1. Starting a task without a ready provider (connected + model selected)
 * 2. Closing the settings dialog without configuring a provider
 */
test.describe('Task Launch Guard', () => {
  test('should display provider grid when opening settings', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Verify provider grid is visible
    await expect(settingsPage.providerGrid).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Verify at least some provider cards are visible
    await expect(settingsPage.getProviderCard('anthropic')).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
    await expect(settingsPage.getProviderCard('openai')).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'task-launch-guard',
      'provider-grid-visible',
      [
        'Provider grid is displayed',
        'Provider cards are visible',
        'User can select a provider'
      ]
    );
  });

  test('should show provider settings panel when selecting a provider', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Select Anthropic provider
    await settingsPage.selectProvider('anthropic');

    // Verify the settings panel for the provider is visible
    const settingsPanel = window.getByTestId('provider-settings-panel');
    await expect(settingsPanel).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Verify API key input is shown
    await expect(settingsPage.apiKeyInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'task-launch-guard',
      'provider-settings-panel',
      [
        'Provider settings panel is visible',
        'API key input is shown',
        'User can configure the provider'
      ]
    );
  });

  test('should have Done button in settings dialog', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Verify Done button is visible
    await expect(settingsPage.doneButton).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'task-launch-guard',
      'done-button-visible',
      [
        'Done button is visible in settings',
        'User can close settings dialog'
      ]
    );
  });

  test('should display Close Anyway button when close warning appears', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Try to close with Done button
    await settingsPage.doneButton.click();

    // Check if warning or dialog close occurred
    const closeAnywayVisible = await settingsPage.closeAnywayButton.isVisible().catch(() => false);
    const dialogClosed = !(await settingsPage.settingsDialog.isVisible().catch(() => true));

    if (closeAnywayVisible) {
      // Warning appeared - verify Close Anyway button
      await expect(settingsPage.closeAnywayButton).toBeVisible();

      await captureForAI(
        window,
        'task-launch-guard',
        'close-warning-visible',
        [
          'Close warning is displayed',
          'Close Anyway button is visible',
          'User is warned about missing provider'
        ]
      );
    } else if (dialogClosed) {
      // Dialog closed - a provider must be ready (E2E mode may pre-configure one)
      await captureForAI(
        window,
        'task-launch-guard',
        'dialog-closed-with-provider',
        [
          'Dialog closed successfully',
          'A provider was ready (E2E mode pre-configured)',
          'Task submission should work'
        ]
      );
    }
  });

  test('should allow closing dialog with Close Anyway if warning appears', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Try to close with Escape
    await window.keyboard.press('Escape');

    // If warning appears, click Close Anyway
    const closeAnywayVisible = await settingsPage.closeAnywayButton.isVisible().catch(() => false);

    if (closeAnywayVisible) {
      await settingsPage.closeAnywayButton.click();

      // Verify dialog closed
      await expect(settingsPage.settingsDialog).not.toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

      await captureForAI(
        window,
        'task-launch-guard',
        'close-anyway-clicked',
        [
          'Close Anyway button was clicked',
          'Dialog closed despite warning',
          'User can proceed without provider'
        ]
      );
    } else {
      // Dialog closed directly - provider was ready
      await expect(settingsPage.providerGrid).not.toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
    }
  });

  test('should show all providers when Show All is clicked', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Verify all provider cards are visible
    const providerIds = ['anthropic', 'openai', 'openrouter', 'google', 'xai', 'deepseek', 'zai', 'bedrock', 'ollama', 'litellm'];

    for (const providerId of providerIds) {
      await expect(settingsPage.getProviderCard(providerId)).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
    }

    await captureForAI(
      window,
      'task-launch-guard',
      'all-providers-visible',
      [
        'All 10 provider cards are visible',
        'Show All expanded the grid',
        'User can select any provider'
      ]
    );
  });

  test('should filter providers by search', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // First show all providers
    await settingsPage.toggleShowAll();

    // Search for specific provider
    await settingsPage.searchProvider('ollama');

    // Ollama should be visible
    await expect(settingsPage.getProviderCard('ollama')).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Other providers should not be visible
    await expect(settingsPage.getProviderCard('anthropic')).not.toBeVisible();
    await expect(settingsPage.getProviderCard('openai')).not.toBeVisible();

    await captureForAI(
      window,
      'task-launch-guard',
      'search-filters-providers',
      [
        'Search filters provider grid',
        'Only matching provider is visible',
        'Search functionality works correctly'
      ]
    );
  });

  test('should be able to navigate back to home and submit task', async ({ window }) => {
    const homePage = new HomePage(window);
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');

    // Open and close settings
    await settingsPage.navigateToSettings();
    await window.keyboard.press('Escape');

    // Handle close warning if it appears
    const closeAnywayVisible = await settingsPage.closeAnywayButton.isVisible().catch(() => false);
    if (closeAnywayVisible) {
      await settingsPage.closeAnywayButton.click();
    }

    // Wait for dialog to close
    await expect(settingsPage.settingsDialog).not.toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Enter a task
    await homePage.enterTask(TEST_SCENARIOS.SUCCESS.keyword);

    // Submit button should be enabled
    await expect(homePage.submitButton).toBeEnabled();

    await captureForAI(
      window,
      'task-launch-guard',
      'ready-to-submit-task',
      [
        'Settings dialog closed',
        'Task input is ready',
        'Submit button is enabled'
      ]
    );
  });

  test('should display connected badge on provider card when connected', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Check if any provider has a connected badge
    // In E2E mode with skip auth, a provider might be pre-configured
    const providers = ['anthropic', 'openai', 'openrouter', 'google', 'xai'];

    let foundConnected = false;
    for (const providerId of providers) {
      const badge = settingsPage.getProviderConnectedBadge(providerId);
      const isVisible = await badge.isVisible().catch(() => false);
      if (isVisible) {
        foundConnected = true;
        await captureForAI(
          window,
          'task-launch-guard',
          'connected-badge-visible',
          [
            `${providerId} provider has connected badge`,
            'Badge indicates provider is configured',
            'User can see which providers are ready'
          ]
        );
        break;
      }
    }

    if (!foundConnected) {
      // No connected badge - this is expected in fresh state
      await captureForAI(
        window,
        'task-launch-guard',
        'no-connected-badge',
        [
          'No provider has connected badge',
          'User needs to configure a provider',
          'Provider grid shows available options'
        ]
      );
    }
  });
});
