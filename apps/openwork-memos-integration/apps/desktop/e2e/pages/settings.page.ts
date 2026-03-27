import type { Page } from '@playwright/test';
import { TEST_TIMEOUTS } from '../config';

export class SettingsPage {
  constructor(private page: Page) {}

  // ===== Provider Grid =====

  get providerGrid() {
    return this.page.getByTestId('provider-grid');
  }

  get providerSearchInput() {
    return this.page.getByTestId('provider-search-input');
  }

  get showAllButton() {
    return this.page.getByRole('button', { name: 'Show All' });
  }

  get hideButton() {
    return this.page.getByRole('button', { name: 'Hide' });
  }

  getProviderCard(providerId: string) {
    return this.page.getByTestId(`provider-card-${providerId}`);
  }

  getProviderConnectedBadge(providerId: string) {
    return this.page.getByTestId(`provider-connected-badge-${providerId}`);
  }

  // ===== Connection Status =====

  get connectionStatus() {
    return this.page.getByTestId('connection-status');
  }

  get disconnectButton() {
    return this.page.getByTestId('disconnect-button');
  }

  get connectButton() {
    return this.page.getByRole('button', { name: 'Connect' });
  }

  // ===== Model Selection =====

  get modelSelector() {
    return this.page.getByTestId('model-selector');
  }

  get modelSelectorError() {
    return this.page.getByTestId('model-selector-error');
  }

  // ===== API Key Input =====

  get apiKeyInput() {
    return this.page.getByTestId('api-key-input');
  }

  get apiKeyHelpLink() {
    return this.page.getByRole('link', { name: 'How can I find it?' });
  }

  // ===== Bedrock Specific =====

  get bedrockAccessKeyTab() {
    return this.page.getByRole('button', { name: 'Access Key' });
  }

  get bedrockAwsProfileTab() {
    return this.page.getByRole('button', { name: 'AWS Profile' });
  }

  get bedrockAccessKeyIdInput() {
    return this.page.getByTestId('bedrock-access-key-id');
  }

  get bedrockSecretKeyInput() {
    return this.page.getByTestId('bedrock-secret-key');
  }

  get bedrockSessionTokenInput() {
    return this.page.getByTestId('bedrock-session-token');
  }

  get bedrockProfileNameInput() {
    return this.page.getByTestId('bedrock-profile-name');
  }

  get bedrockRegionSelect() {
    return this.page.getByTestId('bedrock-region-select');
  }

  // ===== Ollama Specific =====

  get ollamaServerUrlInput() {
    return this.page.getByTestId('ollama-server-url');
  }

  get ollamaConnectionError() {
    return this.page.getByTestId('ollama-connection-error');
  }

  // ===== LiteLLM Specific =====

  get litellmServerUrlInput() {
    return this.page.getByTestId('litellm-server-url');
  }

  get litellmApiKeyInput() {
    return this.page.getByTestId('litellm-api-key');
  }

  // ===== OpenRouter Specific =====

  get openrouterFetchModelsButton() {
    return this.page.getByRole('button', { name: /Fetch Models|Refresh/ });
  }

  // ===== Debug Mode =====

  get debugModeToggle() {
    return this.page.getByTestId('settings-debug-toggle');
  }

  // ===== Dialog =====

  get settingsDialog() {
    return this.page.getByTestId('settings-dialog');
  }

  get doneButton() {
    return this.page.getByTestId('settings-done-button');
  }

  get closeWarning() {
    return this.page.getByText('No provider ready');
  }

  get closeAnywayButton() {
    return this.page.getByRole('button', { name: 'Close Anyway' });
  }

  get sidebarSettingsButton() {
    return this.page.getByTestId('sidebar-settings-button');
  }

  // ===== Actions =====

  async navigateToSettings() {
    await this.sidebarSettingsButton.click();
    await this.settingsDialog.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.NAVIGATION });
  }

  async selectProvider(providerId: string) {
    await this.getProviderCard(providerId).click();
    // Wait for panel to appear
    await this.page.waitForTimeout(300);
  }

  async searchProvider(query: string) {
    await this.providerSearchInput.fill(query);
  }

  async clearSearch() {
    await this.providerSearchInput.clear();
  }

  async toggleShowAll() {
    const showAllVisible = await this.showAllButton.isVisible();
    if (showAllVisible) {
      await this.showAllButton.click();
    } else {
      await this.hideButton.click();
    }
  }

  async enterApiKey(key: string) {
    await this.apiKeyInput.fill(key);
  }

  async clickConnect() {
    await this.connectButton.click();
  }

  async clickDisconnect() {
    await this.disconnectButton.click();
  }

  async selectModel(modelId: string) {
    await this.modelSelector.selectOption(modelId);
  }

  async toggleDebugMode() {
    await this.debugModeToggle.click();
  }

  async closeDialog() {
    await this.doneButton.click();
  }

  async pressEscapeToClose() {
    await this.page.keyboard.press('Escape');
  }

  // Bedrock specific actions
  async selectBedrockAccessKeyTab() {
    await this.bedrockAccessKeyTab.click();
  }

  async selectBedrockAwsProfileTab() {
    await this.bedrockAwsProfileTab.click();
  }

  async enterBedrockAccessKeyCredentials(accessKeyId: string, secretKey: string, sessionToken?: string) {
    await this.bedrockAccessKeyIdInput.fill(accessKeyId);
    await this.bedrockSecretKeyInput.fill(secretKey);
    if (sessionToken) {
      await this.bedrockSessionTokenInput.fill(sessionToken);
    }
  }

  async enterBedrockProfileCredentials(profileName: string) {
    await this.bedrockProfileNameInput.fill(profileName);
  }

  async selectBedrockRegion(region: string) {
    await this.bedrockRegionSelect.selectOption(region);
  }

  // Ollama specific actions
  async enterOllamaServerUrl(url: string) {
    await this.ollamaServerUrlInput.fill(url);
  }

  // LiteLLM specific actions
  async enterLiteLLMServerUrl(url: string) {
    await this.litellmServerUrlInput.fill(url);
  }

  async enterLiteLLMApiKey(key: string) {
    await this.litellmApiKeyInput.fill(key);
  }
}
