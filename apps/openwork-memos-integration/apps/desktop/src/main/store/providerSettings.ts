// apps/desktop/src/main/store/providerSettings.ts

import Store from 'electron-store';
import type { ProviderSettings, ProviderId, ConnectedProvider } from '@accomplish/shared';

const DEFAULT_SETTINGS: ProviderSettings = {
  activeProviderId: null,
  connectedProviders: {},
  debugMode: false,
};

const providerSettingsStore = new Store<ProviderSettings>({
  name: 'provider-settings',
  defaults: DEFAULT_SETTINGS,
});

export function getProviderSettings(): ProviderSettings {
  return {
    activeProviderId: providerSettingsStore.get('activeProviderId') ?? null,
    connectedProviders: providerSettingsStore.get('connectedProviders') ?? {},
    debugMode: providerSettingsStore.get('debugMode') ?? false,
  };
}

export function setActiveProvider(providerId: ProviderId | null): void {
  providerSettingsStore.set('activeProviderId', providerId);
}

export function getActiveProviderId(): ProviderId | null {
  return providerSettingsStore.get('activeProviderId');
}

export function getConnectedProvider(providerId: ProviderId): ConnectedProvider | null {
  const providers = providerSettingsStore.get('connectedProviders');
  return providers[providerId] ?? null;
}

export function setConnectedProvider(providerId: ProviderId, provider: ConnectedProvider): void {
  const providers = providerSettingsStore.get('connectedProviders');
  providerSettingsStore.set('connectedProviders', {
    ...providers,
    [providerId]: provider,
  });
}

export function removeConnectedProvider(providerId: ProviderId): void {
  const providers = providerSettingsStore.get('connectedProviders');
  const { [providerId]: _, ...rest } = providers;
  providerSettingsStore.set('connectedProviders', rest);

  // If this was the active provider, clear it
  if (providerSettingsStore.get('activeProviderId') === providerId) {
    providerSettingsStore.set('activeProviderId', null);
  }
}

export function updateProviderModel(providerId: ProviderId, modelId: string | null): void {
  const provider = getConnectedProvider(providerId);
  if (provider) {
    setConnectedProvider(providerId, {
      ...provider,
      selectedModelId: modelId,
    });
  }
}

export function setProviderDebugMode(enabled: boolean): void {
  providerSettingsStore.set('debugMode', enabled);
}

export function getProviderDebugMode(): boolean {
  return providerSettingsStore.get('debugMode');
}

export function clearProviderSettings(): void {
  providerSettingsStore.clear();
}

/**
 * Get the active provider's model for CLI args
 * Returns null if no active provider or no model selected
 */
export function getActiveProviderModel(): { provider: ProviderId; model: string; baseUrl?: string } | null {
  const settings = getProviderSettings();
  const activeId = settings.activeProviderId;

  if (!activeId) return null;

  const activeProvider = settings.connectedProviders[activeId];
  if (!activeProvider || !activeProvider.selectedModelId) return null;

  const result: { provider: ProviderId; model: string; baseUrl?: string } = {
    provider: activeId,
    model: activeProvider.selectedModelId,
  };

  // Add baseUrl for Ollama/LiteLLM
  if (activeProvider.credentials.type === 'ollama') {
    result.baseUrl = activeProvider.credentials.serverUrl;
  } else if (activeProvider.credentials.type === 'litellm') {
    result.baseUrl = activeProvider.credentials.serverUrl;
  }

  return result;
}

/**
 * Check if any provider is ready (connected with model selected)
 */
export function hasReadyProvider(): boolean {
  const settings = getProviderSettings();
  return Object.values(settings.connectedProviders).some(
    p => p && p.connectionStatus === 'connected' && p.selectedModelId !== null
  );
}

/**
 * Get all connected provider IDs for enabled_providers config
 */
export function getConnectedProviderIds(): ProviderId[] {
  const settings = getProviderSettings();
  return Object.values(settings.connectedProviders)
    .filter((p): p is ConnectedProvider => p !== undefined && p.connectionStatus === 'connected')
    .map(p => p.providerId);
}
