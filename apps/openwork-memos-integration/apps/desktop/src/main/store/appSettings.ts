import Store from 'electron-store';
import { randomUUID } from 'crypto';
import type { SelectedModel, OllamaConfig, LiteLLMConfig } from '@accomplish/shared';

/**
 * App settings schema
 */
interface AppSettingsSchema {
  /** Enable debug mode to show backend logs in UI */
  debugMode: boolean;
  /** Whether the user has completed the onboarding wizard */
  onboardingComplete: boolean;
  /** Selected AI model (provider/model format) */
  selectedModel: SelectedModel | null;
  /** Ollama server configuration */
  ollamaConfig: OllamaConfig | null;
  /** LiteLLM proxy configuration */
  litellmConfig: LiteLLMConfig | null;
  /** Stable user ID for memory services */
  memoryUserId: string;
}

const appSettingsStore = new Store<AppSettingsSchema>({
  name: 'app-settings',
  defaults: {
    debugMode: false,
    onboardingComplete: false,
    selectedModel: {
      provider: 'anthropic',
      model: 'anthropic/claude-opus-4-5',
    },
    ollamaConfig: null,
    litellmConfig: null,
    memoryUserId: '',
  },
});

/**
 * Get debug mode setting
 */
export function getDebugMode(): boolean {
  return appSettingsStore.get('debugMode');
}

/**
 * Set debug mode setting
 */
export function setDebugMode(enabled: boolean): void {
  appSettingsStore.set('debugMode', enabled);
}

/**
 * Get onboarding complete setting
 */
export function getOnboardingComplete(): boolean {
  return appSettingsStore.get('onboardingComplete');
}

/**
 * Set onboarding complete setting
 */
export function setOnboardingComplete(complete: boolean): void {
  appSettingsStore.set('onboardingComplete', complete);
}

/**
 * Get selected model
 */
export function getSelectedModel(): SelectedModel | null {
  return appSettingsStore.get('selectedModel');
}

/**
 * Set selected model
 */
export function setSelectedModel(model: SelectedModel): void {
  appSettingsStore.set('selectedModel', model);
}

/**
 * Get Ollama configuration
 */
export function getOllamaConfig(): OllamaConfig | null {
  return appSettingsStore.get('ollamaConfig');
}

/**
 * Set Ollama configuration
 */
export function setOllamaConfig(config: OllamaConfig | null): void {
  appSettingsStore.set('ollamaConfig', config);
}

/**
 * Get LiteLLM configuration
 */
export function getLiteLLMConfig(): LiteLLMConfig | null {
  return appSettingsStore.get('litellmConfig');
}

/**
 * Set LiteLLM configuration
 */
export function setLiteLLMConfig(config: LiteLLMConfig | null): void {
  appSettingsStore.set('litellmConfig', config);
}

/**
 * Get or create stable memory user ID
 */
export function getMemoryUserId(): string {
  let userId = appSettingsStore.get('memoryUserId');
  if (!userId) {
    userId = randomUUID();
    appSettingsStore.set('memoryUserId', userId);
  }
  return userId;
}

/**
 * Get all app settings
 */
export function getAppSettings(): AppSettingsSchema {
  return {
    debugMode: appSettingsStore.get('debugMode'),
    onboardingComplete: appSettingsStore.get('onboardingComplete'),
    selectedModel: appSettingsStore.get('selectedModel'),
    ollamaConfig: appSettingsStore.get('ollamaConfig') ?? null,
    litellmConfig: appSettingsStore.get('litellmConfig') ?? null,
    memoryUserId: appSettingsStore.get('memoryUserId'),
  };
}

/**
 * Clear all app settings (reset to defaults)
 * Used during fresh install cleanup
 */
export function clearAppSettings(): void {
  appSettingsStore.clear();
}
