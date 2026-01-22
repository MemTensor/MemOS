// apps/desktop/src/renderer/components/settings/providers/LiteLLMProviderForm.tsx

import { useState } from 'react';
import type { ConnectedProvider, LiteLLMCredentials } from '@accomplish/shared';
import {
  ModelSelector,
  ConnectButton,
  ConnectedControls,
  ProviderFormHeader,
  FormError,
} from '../shared';

// Import LiteLLM logo
import litellmLogo from '/assets/ai-logos/litellm.svg';

interface LiteLLMProviderFormProps {
  connectedProvider?: ConnectedProvider;
  onConnect: (provider: ConnectedProvider) => void;
  onDisconnect: () => void;
  onModelChange: (modelId: string) => void;
  showModelError: boolean;
}

export function LiteLLMProviderForm({
  connectedProvider,
  onConnect,
  onDisconnect,
  onModelChange,
  showModelError,
}: LiteLLMProviderFormProps) {
  const [serverUrl, setServerUrl] = useState('http://localhost:4000');
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConnected = connectedProvider?.connectionStatus === 'connected';

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    try {
      // For now, just create a placeholder connected state
      const provider: ConnectedProvider = {
        providerId: 'litellm',
        connectionStatus: 'connected',
        selectedModelId: null,
        credentials: {
          type: 'litellm',
          serverUrl,
          hasApiKey: !!apiKey.trim(),
          keyPrefix: apiKey.trim() ? apiKey.trim().substring(0, 10) + '...' : undefined,
        } as LiteLLMCredentials,
        lastConnectedAt: new Date().toISOString(),
        availableModels: [],
      };

      onConnect(provider);
      setApiKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const models = connectedProvider?.availableModels || [];

  return (
    <div className="rounded-xl border border-border bg-card p-5" data-testid="provider-settings-panel">
      <ProviderFormHeader logoSrc={litellmLogo} providerName="LiteLLM" />

      <div className="space-y-3">
        {!isConnected ? (
          <>
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">Server URL</label>
              <input
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://localhost:4000"
                data-testid="litellm-server-url"
                className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">
                API Key <span className="text-muted-foreground">(Optional)</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Optional API key"
                  data-testid="litellm-api-key"
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2.5 text-sm"
                />
                <button
                  onClick={() => setApiKey('')}
                  className="rounded-md border border-border p-2.5 text-muted-foreground hover:text-foreground transition-colors"
                  type="button"
                  disabled={!apiKey}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>

            <FormError error={error} />
            <ConnectButton onClick={handleConnect} connecting={connecting} />
          </>
        ) : (
          <>
            {/* Display saved connection details */}
            <div className="space-y-3">
              <div>
                <label className="mb-2 block text-sm font-medium text-foreground">Server URL</label>
                <input
                  type="text"
                  value={(connectedProvider?.credentials as LiteLLMCredentials)?.serverUrl || 'http://localhost:4000'}
                  disabled
                  className="w-full rounded-md border border-input bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
                />
              </div>
              {(connectedProvider?.credentials as LiteLLMCredentials)?.hasApiKey && (
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">API Key</label>
                  <input
                    type="text"
                    value={(connectedProvider?.credentials as LiteLLMCredentials)?.keyPrefix || 'API key saved'}
                    disabled
                    className="w-full rounded-md border border-input bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
                  />
                </div>
              )}
            </div>

            <ConnectedControls onDisconnect={onDisconnect} />

            {/* Model Selector */}
            <ModelSelector
              models={models}
              value={connectedProvider?.selectedModelId || null}
              onChange={onModelChange}
              error={showModelError && !connectedProvider?.selectedModelId}
            />
          </>
        )}
      </div>
    </div>
  );
}
