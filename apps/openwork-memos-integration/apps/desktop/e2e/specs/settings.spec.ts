import { test, expect } from '../fixtures';
import { SettingsPage, HomePage, ExecutionPage } from '../pages';
import { captureForAI } from '../utils';
import { TEST_TIMEOUTS, TEST_SCENARIOS } from '../config';

test.describe('Settings Dialog', () => {
  test('should open settings dialog when clicking settings button', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    // Fixture already handles hydration, just ensure DOM is ready
    await window.waitForLoadState('domcontentloaded');

    // Click the settings button in sidebar
    await settingsPage.navigateToSettings();

    // Capture settings dialog
    await captureForAI(
      window,
      'settings-dialog',
      'dialog-open',
      [
        'Settings dialog is visible',
        'Dialog contains provider grid',
        'User can interact with settings'
      ]
    );

    // Verify dialog opened by checking for provider grid
    await expect(settingsPage.providerGrid).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
  });

  test('should display provider grid with cards', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Verify provider grid is visible
    await expect(settingsPage.providerGrid).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture provider grid
    await captureForAI(
      window,
      'settings-dialog',
      'provider-grid',
      [
        'Provider grid is visible',
        'Provider cards are displayed',
        'User can select a provider'
      ]
    );
  });

  test('should use 4-column grid layout without horizontal scroll', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Wait for provider grid to be visible
    await expect(settingsPage.providerGrid).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Get the settings dialog element
    const settingsDialog = window.getByTestId('settings-dialog');

    // Get the provider grid element
    const providerGrid = settingsPage.providerGrid;

    // Check that settings dialog does NOT have horizontal scroll
    const dialogOverflowX = await settingsDialog.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.overflowX;
    });

    // Dialog should have auto or hidden overflow-x, not scroll
    expect(['auto', 'hidden', 'visible']).toContain(dialogOverflowX);

    // Verify the grid uses 4-column layout (grid-cols-4)
    const gridContainer = providerGrid.locator('.grid.grid-cols-4').first();
    await expect(gridContainer).toBeVisible();

    // In collapsed view, first 4 providers should be visible
    await expect(settingsPage.getProviderCard('anthropic')).toBeVisible();
    await expect(settingsPage.getProviderCard('openai')).toBeVisible();
    await expect(settingsPage.getProviderCard('google')).toBeVisible();
    await expect(settingsPage.getProviderCard('bedrock')).toBeVisible();

    // 5th provider should NOT be visible in collapsed view
    await expect(settingsPage.getProviderCard('deepseek')).not.toBeVisible();

    // Capture for verification
    await captureForAI(
      window,
      'settings-dialog',
      'grid-layout',
      [
        'Settings dialog uses 4-column grid layout',
        'First 4 providers visible in collapsed view',
        'No horizontal scroll needed'
      ]
    );
  });

  test('should display API key input when selecting a classic provider', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Select Anthropic provider (a classic provider requiring API key)
    await settingsPage.selectProvider('anthropic');

    // Scroll to API key section if needed
    await settingsPage.apiKeyInput.scrollIntoViewIfNeeded();

    // Verify API key input is visible
    await expect(settingsPage.apiKeyInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture API key section
    await captureForAI(
      window,
      'settings-dialog',
      'api-key-section',
      [
        'API key input is visible',
        'User can enter an API key',
        'Input is accessible'
      ]
    );
  });

  test('should allow typing in API key input', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Select Anthropic provider
    await settingsPage.selectProvider('anthropic');

    // Scroll to API key input
    await settingsPage.apiKeyInput.scrollIntoViewIfNeeded();

    // Type in API key input
    const testKey = 'sk-ant-test-key-12345';
    await settingsPage.apiKeyInput.fill(testKey);

    // Verify value was entered
    await expect(settingsPage.apiKeyInput).toHaveValue(testKey);

    // Capture filled state
    await captureForAI(
      window,
      'settings-dialog',
      'api-key-filled',
      [
        'API key input has value',
        'Input accepts text entry',
        'Value is correctly displayed'
      ]
    );
  });

  test('should display debug mode toggle', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Debug toggle only shows when a provider is selected - select one first
    await settingsPage.getProviderCard('anthropic').click();

    // Scroll to debug toggle
    await settingsPage.debugModeToggle.scrollIntoViewIfNeeded();

    // Verify debug toggle is visible
    await expect(settingsPage.debugModeToggle).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture debug section
    await captureForAI(
      window,
      'settings-dialog',
      'debug-section',
      [
        'Debug mode toggle is visible',
        'Toggle is clickable',
        'Developer settings are accessible'
      ]
    );
  });

  test('should allow toggling debug mode', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Debug toggle only shows when a provider is selected - select one first
    await settingsPage.getProviderCard('anthropic').click();

    // Scroll to debug toggle
    await settingsPage.debugModeToggle.scrollIntoViewIfNeeded();

    // Capture initial state
    await captureForAI(
      window,
      'settings-dialog',
      'debug-before-toggle',
      [
        'Debug toggle in initial state',
        'Toggle is ready to click'
      ]
    );

    // Click toggle - state change is immediate in React
    await settingsPage.toggleDebugMode();

    // Capture toggled state
    await captureForAI(
      window,
      'settings-dialog',
      'debug-after-toggle',
      [
        'Debug toggle state changed',
        'UI reflects new state'
      ]
    );
  });

  test('should close dialog when pressing Escape', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Verify dialog is open
    await expect(settingsPage.providerGrid).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Press Escape to close dialog
    await window.keyboard.press('Escape');

    // Dialog might show warning if no provider is ready, click Close Anyway if visible
    const closeAnywayVisible = await settingsPage.closeAnywayButton.isVisible().catch(() => false);
    if (closeAnywayVisible) {
      await settingsPage.closeAnywayButton.click();
    }

    // Verify dialog closed (provider grid should not be visible)
    await expect(settingsPage.providerGrid).not.toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture closed state
    await captureForAI(
      window,
      'settings-dialog',
      'dialog-closed',
      [
        'Dialog is closed',
        'Main app is visible again',
        'Settings are no longer shown'
      ]
    );
  });

  test('should display DeepSeek provider card', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Verify DeepSeek provider card is visible
    const deepseekCard = settingsPage.getProviderCard('deepseek');
    await expect(deepseekCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture provider selection area
    await captureForAI(
      window,
      'settings-dialog',
      'deepseek-provider-visible',
      [
        'DeepSeek provider card is visible in settings',
        'Provider card can be clicked',
        'User can select DeepSeek as their provider'
      ]
    );
  });

  test('should allow selecting DeepSeek provider and entering API key', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click DeepSeek provider
    await settingsPage.selectProvider('deepseek');

    // Enter API key
    const testKey = 'sk-deepseek-test-key-12345';
    await settingsPage.apiKeyInput.fill(testKey);

    // Verify value was entered
    await expect(settingsPage.apiKeyInput).toHaveValue(testKey);

    // Capture filled state
    await captureForAI(
      window,
      'settings-dialog',
      'deepseek-api-key-filled',
      [
        'DeepSeek provider is selected',
        'API key input accepts DeepSeek key format',
        'Value is correctly displayed'
      ]
    );
  });

  test('should display Z.AI provider card', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Verify Z.AI provider card is visible
    const zaiCard = settingsPage.getProviderCard('zai');
    await expect(zaiCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture provider selection area
    await captureForAI(
      window,
      'settings-dialog',
      'zai-provider-visible',
      [
        'Z.AI provider card is visible in settings',
        'Provider card can be clicked',
        'User can select Z.AI as their provider'
      ]
    );
  });

  test('should allow selecting Z.AI provider and entering API key', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Z.AI provider
    await settingsPage.selectProvider('zai');

    // Enter API key
    const testKey = 'zai-test-api-key-67890';
    await settingsPage.apiKeyInput.fill(testKey);

    // Verify value was entered
    await expect(settingsPage.apiKeyInput).toHaveValue(testKey);

    // Capture filled state
    await captureForAI(
      window,
      'settings-dialog',
      'zai-api-key-filled',
      [
        'Z.AI provider is selected',
        'API key input accepts Z.AI key format',
        'Value is correctly displayed'
      ]
    );
  });

  test('should display all provider cards when Show All is clicked', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Verify provider cards are visible (using provider IDs)
    const providerIds = ['anthropic', 'openai', 'openrouter', 'google', 'xai', 'deepseek', 'zai', 'bedrock', 'ollama', 'litellm'];

    for (const providerId of providerIds) {
      const card = settingsPage.getProviderCard(providerId);
      await expect(card).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
    }

    // Capture all providers
    await captureForAI(
      window,
      'settings-dialog',
      'all-providers-visible',
      [
        'All provider cards are visible',
        'Provider grid shows complete selection',
        'User can select any provider'
      ]
    );
  });

  test('should display OpenRouter provider card', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers (OpenRouter is not in first 6)
    await settingsPage.toggleShowAll();

    // Verify OpenRouter provider card is visible
    const openrouterCard = settingsPage.getProviderCard('openrouter');
    await expect(openrouterCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture provider selection area
    await captureForAI(
      window,
      'settings-dialog',
      'openrouter-provider-visible',
      [
        'OpenRouter provider card is visible in settings',
        'Provider card can be clicked',
        'User can select OpenRouter as their provider'
      ]
    );
  });

  test('should allow selecting OpenRouter provider and entering API key', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers (OpenRouter is not in first 6)
    await settingsPage.toggleShowAll();

    // Click OpenRouter provider
    await settingsPage.selectProvider('openrouter');

    // Enter API key
    const testKey = 'sk-or-v1-test-key-12345';
    await settingsPage.apiKeyInput.fill(testKey);

    // Verify value was entered
    await expect(settingsPage.apiKeyInput).toHaveValue(testKey);

    // Capture filled state
    await captureForAI(
      window,
      'settings-dialog',
      'openrouter-api-key-filled',
      [
        'OpenRouter provider is selected',
        'API key input accepts OpenRouter key format',
        'Value is correctly displayed'
      ]
    );
  });

  test('should show LiteLLM provider card and settings', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click LiteLLM provider
    await settingsPage.selectProvider('litellm');

    // Verify LiteLLM server URL input is visible
    await expect(settingsPage.litellmServerUrlInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture LiteLLM settings
    await captureForAI(
      window,
      'settings-dialog',
      'litellm-settings',
      [
        'LiteLLM provider is selected',
        'Server URL input is visible',
        'User can configure LiteLLM connection'
      ]
    );
  });

  test('should show Ollama provider card and settings', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Ollama provider
    await settingsPage.selectProvider('ollama');

    // Verify Ollama server URL input is visible
    await expect(settingsPage.ollamaServerUrlInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture Ollama settings
    await captureForAI(
      window,
      'settings-dialog',
      'ollama-settings',
      [
        'Ollama provider is selected',
        'Server URL input is visible',
        'User can configure Ollama connection'
      ]
    );
  });

  test('should filter providers with search', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All first
    await settingsPage.toggleShowAll();

    // Search for "anthropic"
    await settingsPage.searchProvider('anthropic');

    // Anthropic should be visible
    await expect(settingsPage.getProviderCard('anthropic')).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Other providers should not be visible
    await expect(settingsPage.getProviderCard('openai')).not.toBeVisible();

    // Capture filtered state
    await captureForAI(
      window,
      'settings-dialog',
      'provider-search',
      [
        'Search filters provider cards',
        'Only matching providers visible',
        'Search functionality works'
      ]
    );

    // Clear search
    await settingsPage.clearSearch();

    // All providers should be visible again
    await expect(settingsPage.getProviderCard('openai')).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
  });

  /**
   * Regression test for: "Maximum update depth exceeded" infinite loop bug
   *
   * Bug: Execution.tsx called getAccomplish() on every render, creating a new
   * object reference. This was used as a useEffect dependency, causing:
   * render -> new accomplish -> useEffect runs -> setState -> render -> loop
   *
   * This test verifies Settings dialog opens correctly after a task completes.
   */
  test('should open settings dialog after task completes without crashing', async ({ window }) => {
    const homePage = new HomePage(window);
    const executionPage = new ExecutionPage(window);
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');

    // Step 1: Start a task
    await homePage.enterTask(TEST_SCENARIOS.SUCCESS.keyword);
    await homePage.submitTask();

    // Step 2: Wait for navigation to execution page
    await window.waitForURL(/.*#\/execution.*/, { timeout: TEST_TIMEOUTS.NAVIGATION });

    // Step 3: Wait for task to complete
    await executionPage.waitForComplete();

    // Verify task completed
    await expect(executionPage.statusBadge).toBeVisible();

    // Step 4: Open settings dialog - this is where the bug would cause infinite loop
    // The test should NOT timeout here. If it does, the infinite loop bug is present.
    await settingsPage.navigateToSettings();

    // Step 5: Verify settings dialog opened successfully (no crash/freeze)
    await expect(settingsPage.providerGrid).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Additional verification: can interact with the dialog
    const dialogTitle = window.getByRole('heading', { name: 'Set up Openwork' });
    await expect(dialogTitle).toBeVisible();

    // Capture successful state
    await captureForAI(
      window,
      'settings-dialog',
      'after-task-completion',
      [
        'Settings dialog opened successfully after task completion',
        'No infinite loop or crash occurred',
        'Dialog is fully functional'
      ]
    );
  });

  /**
   * Bug test: Green background should only show on active+ready provider
   *
   * Bug: Both isActive and isSelected were getting the same green background.
   * Expected: Green background should ONLY show on the active provider that is
   * connected AND has a model selected (isProviderReady). When clicking another
   * provider to view its settings, it should NOT get the green background.
   *
   * In the E2E test environment, no provider is connected/ready, so we test that
   * clicking to select a provider does NOT give it the green background.
   */
  test('should only show green background on active ready provider, not on selected provider', async ({ window }) => {
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers including Z-AI
    await settingsPage.toggleShowAll();

    // Define color constants
    const GREEN_BACKGROUND = 'rgb(233, 247, 231)'; // #e9f7e7 - for active+ready providers only
    const DEFAULT_BACKGROUND = 'rgb(249, 248, 246)'; // #f9f8f6 - for unselected providers

    // Get the Anthropic card
    const anthropicCard = settingsPage.getProviderCard('anthropic');
    await expect(anthropicCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // In E2E test environment, no provider is active+ready, so Anthropic should have default bg
    const anthropicBgBefore = await anthropicCard.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });
    expect(anthropicBgBefore).toBe(DEFAULT_BACKGROUND);

    // Get the Z-AI card
    const zaiCard = settingsPage.getProviderCard('zai');
    await expect(zaiCard).toBeVisible();

    // Verify Z-AI has the default background before clicking
    const zaiBgBefore = await zaiCard.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });
    expect(zaiBgBefore).toBe(DEFAULT_BACKGROUND);

    // Click on Z-AI to select it (but it's not connected/ready)
    await settingsPage.selectProvider('zai');

    // BUG TEST: Z-AI should NOT have the green background after being selected
    // The bug was that isSelected triggered the green background, which is incorrect.
    // Green background should ONLY appear for active+ready providers (isActive && isProviderReady).
    // A selected-but-not-ready provider should only get a selection border, not green background.
    const zaiBgAfter = await zaiCard.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // This assertion will FAIL if the bug exists (zai gets green background when selected)
    // and PASS once the bug is fixed (zai keeps default background when selected)
    expect(zaiBgAfter).toBe(DEFAULT_BACKGROUND);

    // Capture for verification
    await captureForAI(
      window,
      'settings-dialog',
      'green-background-bug-test',
      [
        'Selected but non-ready provider does not have green background',
        'Bug is fixed - isSelected does not trigger green background',
        'Only active+ready providers should have green background'
      ]
    );
  });

  test('should enable debug mode and show debug panel on execution page', async ({ window }) => {
    const homePage = new HomePage(window);
    const settingsPage = new SettingsPage(window);

    await window.waitForLoadState('domcontentloaded');

    // Step 1: Open settings and toggle debug mode
    await settingsPage.navigateToSettings();

    // Debug toggle only shows when a provider is selected - select one first
    await settingsPage.getProviderCard('anthropic').click();
    await expect(settingsPage.debugModeToggle).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    const toggleButton = settingsPage.debugModeToggle;

    // Check current state of toggle and ensure it's ON for the test
    const initialBgClass = await toggleButton.getAttribute('class');
    const isInitiallyOff = initialBgClass?.includes('bg-muted');

    if (isInitiallyOff) {
      // Click to enable debug mode
      await settingsPage.toggleDebugMode();
    }

    // Verify toggle is now in ON state
    await expect(toggleButton).toHaveClass(/bg-primary/);

    // Verify warning message appears when debug is enabled
    const warningMessage = window.getByText('Debug mode is enabled');
    await expect(warningMessage).toBeVisible();

    // Step 2: Close settings (force close since no provider is set up)
    await settingsPage.pressEscapeToClose();
    // If warning appears, click Close Anyway
    const closeAnyway = settingsPage.closeAnywayButton;
    if (await closeAnyway.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeAnyway.click();
    }

    // Step 3: Start a task
    await homePage.enterTask(TEST_SCENARIOS.SUCCESS.keyword);
    await homePage.submitTask();

    // Step 4: Wait for navigation to execution page
    await window.waitForURL(/.*#\/execution.*/, { timeout: TEST_TIMEOUTS.NAVIGATION });

    // Step 5: Verify debug panel is visible on execution page
    // This is the key assertion - debug mode toggle in settings should affect execution page
    const debugPanel = window.getByTestId('debug-panel');
    await expect(debugPanel).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture the debug panel
    await captureForAI(
      window,
      'execution-page',
      'debug-panel-enabled',
      [
        'Debug panel is visible at bottom of execution page',
        'Debug mode was successfully enabled in settings',
        'Panel shows Debug Logs header'
      ]
    );
  });

});
