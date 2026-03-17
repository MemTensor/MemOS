// apps/desktop/src/renderer/components/settings/providers/OllamaProviderForm.tsx

import { useState } from 'react';
import { getAccomplish } from '@/lib/accomplish';
import type { ConnectedProvider, OllamaCredentials } from '@accomplish/shared';
import {
  ModelSelector,
  ConnectButton,
  ConnectedControls,
  ProviderFormHeader,
  FormError,
} from '../shared';

// Import Ollama logo
import ollamaLogo from '/assets/ai-logos/ollama.svg';

interface OllamaProviderFormProps {
  connectedProvider?: ConnectedProvider;
  onConnect: (provider: ConnectedProvider) => void;
  onDisconnect: () => void;
  onModelChange: (modelId: string) => void;
  showModelError: boolean;
}

export function OllamaProviderForm({
  connectedProvider,
  onConnect,
  onDisconnect,
  onModelChange,
  showModelError,
}: OllamaProviderFormProps) {
  const [serverUrl, setServerUrl] = useState('http://localhost:11434');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);

  const isConnected = connectedProvider?.connectionStatus === 'connected';

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    try {
      const accomplish = getAccomplish();
      const result = await accomplish.testOllamaConnection(serverUrl);

      if (!result.success) {
        setError(result.error || 'Connection failed');
        setConnecting(false);
        return;
      }

      const models = result.models?.map(m => ({
        id: `ollama/${m.id}`,
        name: m.displayName,
      })) || [];
      setAvailableModels(models);

      const provider: ConnectedProvider = {
        providerId: 'ollama',
        connectionStatus: 'connected',
        selectedModelId: null,
        credentials: {
          type: 'ollama',
          serverUrl,
        } as OllamaCredentials,
        lastConnectedAt: new Date().toISOString(),
        availableModels: models,
      };

      onConnect(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const models = connectedProvider?.availableModels || availableModels;

  return (
    <div className="rounded-xl border border-border bg-card p-5" data-testid="provider-settings-panel">
      <ProviderFormHeader logoSrc={ollamaLogo} providerName="Ollama" />

      <div className="space-y-3">
        {!isConnected ? (
          <>
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">Ollama Server URL</label>
              <input
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://localhost:11434"
                data-testid="ollama-server-url"
                className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm"
              />
            </div>

            <FormError error={error} />
            <ConnectButton onClick={handleConnect} connecting={connecting} />
          </>
        ) : (
          <>
            {/* Display saved server URL */}
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">Ollama Server URL</label>
              <input
                type="text"
                value={(connectedProvider?.credentials as OllamaCredentials)?.serverUrl || 'http://localhost:11434'}
                disabled
                className="w-full rounded-md border border-input bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
              />
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
