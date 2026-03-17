// packages/shared/src/types/providerSettings.ts

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'zai'
  | 'bedrock'
  | 'ollama'
  | 'openrouter'
  | 'litellm';

export type ProviderCategory = 'classic' | 'aws' | 'local' | 'proxy' | 'hybrid';

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  category: ProviderCategory;
  label: string; // "Service" or "Local Models"
  logoKey: string; // For icon lookup
  helpUrl?: string; // "How can I find it?" link
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  anthropic: { id: 'anthropic', name: 'Anthropic', category: 'classic', label: 'Service', logoKey: 'claude', helpUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { id: 'openai', name: 'OpenAI', category: 'classic', label: 'Service', logoKey: 'open-ai', helpUrl: 'https://platform.openai.com/api-keys' },
  google: { id: 'google', name: 'Gemini', category: 'classic', label: 'Service', logoKey: 'google-gen-ai', helpUrl: 'https://aistudio.google.com/app/apikey' },
  xai: { id: 'xai', name: 'XAI', category: 'classic', label: 'Service', logoKey: 'Xai', helpUrl: 'https://x.ai/api' },
  deepseek: { id: 'deepseek', name: 'DeepSeek', category: 'classic', label: 'Service', logoKey: 'Deepseek', helpUrl: 'https://platform.deepseek.com/api_keys' },
  zai: { id: 'zai', name: 'Z-AI', category: 'classic', label: 'Service', logoKey: 'z-ai' },
  bedrock: { id: 'bedrock', name: 'AWS Bedrock', category: 'aws', label: 'Service', logoKey: 'aws-bedrock' },
  ollama: { id: 'ollama', name: 'Ollama', category: 'local', label: 'Local Models', logoKey: 'olama' },
  openrouter: { id: 'openrouter', name: 'OpenRouter', category: 'proxy', label: 'Service', logoKey: 'open-router', helpUrl: 'https://openrouter.ai/keys' },
  litellm: { id: 'litellm', name: 'LiteLLM', category: 'hybrid', label: 'Service', logoKey: 'liteLLM' },
};

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ApiKeyCredentials {
  type: 'api_key';
  keyPrefix: string;
}

export interface BedrockProviderCredentials {
  type: 'bedrock';
  authMethod: 'accessKey' | 'profile';
  region: string;
  accessKeyIdPrefix?: string;
  profileName?: string;
}

export interface OllamaCredentials {
  type: 'ollama';
  serverUrl: string;
}

export interface OpenRouterCredentials {
  type: 'openrouter';
  keyPrefix: string;
}

export interface LiteLLMCredentials {
  type: 'litellm';
  serverUrl: string;
  hasApiKey: boolean;
  keyPrefix?: string;
}

export type ProviderCredentials =
  | ApiKeyCredentials
  | BedrockProviderCredentials
  | OllamaCredentials
  | OpenRouterCredentials
  | LiteLLMCredentials;

export interface ConnectedProvider {
  providerId: ProviderId;
  connectionStatus: ConnectionStatus;
  selectedModelId: string | null;
  credentials: ProviderCredentials;
  lastConnectedAt: string;
  availableModels?: Array<{ id: string; name: string }>; // For dynamic providers
}

export interface ProviderSettings {
  activeProviderId: ProviderId | null;
  connectedProviders: Partial<Record<ProviderId, ConnectedProvider>>;
  debugMode: boolean;
}

export function isProviderReady(provider: ConnectedProvider | undefined): boolean {
  if (!provider) return false;
  return provider.connectionStatus === 'connected' && provider.selectedModelId !== null;
}

export function hasAnyReadyProvider(settings: ProviderSettings | null | undefined): boolean {
  if (!settings?.connectedProviders) return false;
  return Object.values(settings.connectedProviders).some(isProviderReady);
}

export function getActiveProvider(settings: ProviderSettings | null | undefined): ConnectedProvider | null {
  if (!settings?.activeProviderId) return null;
  return settings.connectedProviders?.[settings.activeProviderId] ?? null;
}

/**
 * Default models for main providers (auto-selected on connection)
 * These are the recommended models for each provider
 */
export const DEFAULT_MODELS: Partial<Record<ProviderId, string>> = {
  anthropic: 'anthropic/claude-haiku-4-5',
  openai: 'openai/gpt-5-codex',
  google: 'google/gemini-3-pro-preview',
  xai: 'xai/grok-4',
  bedrock: 'amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
};

/**
 * Get the default model for a provider (if one exists)
 */
export function getDefaultModelForProvider(providerId: ProviderId): string | null {
  return DEFAULT_MODELS[providerId] ?? null;
}
