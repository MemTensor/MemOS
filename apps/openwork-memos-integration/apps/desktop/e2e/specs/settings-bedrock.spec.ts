import { test, expect } from '../fixtures';
import { SettingsPage } from '../pages';
import { captureForAI } from '../utils';
import { TEST_TIMEOUTS } from '../config';

test.describe('Settings - Amazon Bedrock', () => {
  test('should display Bedrock provider card', async ({ window }) => {
    const settingsPage = new SettingsPage(window);
    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    const bedrockCard = settingsPage.getProviderCard('bedrock');
    await expect(bedrockCard).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'settings-bedrock',
      'provider-card-visible',
      ['Bedrock provider card is visible', 'User can select Bedrock']
    );
  });

  test('should show Bedrock credential form when selected', async ({ window }) => {
    const settingsPage = new SettingsPage(window);
    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Bedrock provider card
    await settingsPage.selectProvider('bedrock');

    // Verify Access Key tab is visible (default)
    await expect(settingsPage.bedrockAccessKeyTab).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
    await expect(settingsPage.bedrockAwsProfileTab).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'settings-bedrock',
      'credential-form-visible',
      ['Bedrock credential form is visible', 'Auth tabs are shown']
    );
  });

  test('should switch between Access Key and AWS Profile tabs', async ({ window }) => {
    const settingsPage = new SettingsPage(window);
    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Bedrock provider card
    await settingsPage.selectProvider('bedrock');

    // Default is Access Key - verify inputs
    await expect(settingsPage.bedrockAccessKeyIdInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
    await expect(settingsPage.bedrockSecretKeyInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    // Switch to AWS Profile tab
    await settingsPage.selectBedrockAwsProfileTab();
    await expect(settingsPage.bedrockProfileNameInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });
    await expect(settingsPage.bedrockAccessKeyIdInput).not.toBeVisible();

    // Switch back to Access Key
    await settingsPage.selectBedrockAccessKeyTab();
    await expect(settingsPage.bedrockAccessKeyIdInput).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'settings-bedrock',
      'tab-switching',
      ['Can switch between auth tabs', 'Form fields update correctly']
    );
  });

  test('should allow typing in Bedrock access key fields', async ({ window }) => {
    const settingsPage = new SettingsPage(window);
    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Bedrock provider card
    await settingsPage.selectProvider('bedrock');

    const testAccessKey = 'AKIAIOSFODNN7EXAMPLE';
    const testSecretKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    await settingsPage.bedrockAccessKeyIdInput.fill(testAccessKey);
    await settingsPage.bedrockSecretKeyInput.fill(testSecretKey);

    await expect(settingsPage.bedrockAccessKeyIdInput).toHaveValue(testAccessKey);
    await expect(settingsPage.bedrockSecretKeyInput).toHaveValue(testSecretKey);

    // Verify region selector is visible
    await expect(settingsPage.bedrockRegionSelect).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'settings-bedrock',
      'access-key-fields-filled',
      ['Access key fields accept input', 'Region selector is available']
    );
  });

  test('should allow typing in Bedrock profile fields', async ({ window }) => {
    const settingsPage = new SettingsPage(window);
    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Bedrock provider card
    await settingsPage.selectProvider('bedrock');

    // Switch to AWS Profile tab
    await settingsPage.selectBedrockAwsProfileTab();

    const testProfile = 'my-aws-profile';

    await settingsPage.bedrockProfileNameInput.clear();
    await settingsPage.bedrockProfileNameInput.fill(testProfile);

    await expect(settingsPage.bedrockProfileNameInput).toHaveValue(testProfile);

    // Verify region selector is visible
    await expect(settingsPage.bedrockRegionSelect).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'settings-bedrock',
      'profile-fields-filled',
      ['Profile field accepts input', 'Region selector is available']
    );
  });

  test('should have Connect button for Bedrock credentials', async ({ window }) => {
    const settingsPage = new SettingsPage(window);
    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Bedrock provider card
    await settingsPage.selectProvider('bedrock');

    // Verify Connect button is visible
    await expect(settingsPage.connectButton).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'settings-bedrock',
      'connect-button-visible',
      ['Connect button is visible', 'User can connect to Bedrock']
    );
  });

  test('should display region selector for Bedrock', async ({ window }) => {
    const settingsPage = new SettingsPage(window);
    await window.waitForLoadState('domcontentloaded');
    await settingsPage.navigateToSettings();

    // Click Show All to see all providers
    await settingsPage.toggleShowAll();

    // Click Bedrock provider card
    await settingsPage.selectProvider('bedrock');

    // Verify region selector is visible
    await expect(settingsPage.bedrockRegionSelect).toBeVisible({ timeout: TEST_TIMEOUTS.NAVIGATION });

    await captureForAI(
      window,
      'settings-bedrock',
      'region-selector-visible',
      ['Region selector is visible', 'User can select AWS region']
    );
  });
});
