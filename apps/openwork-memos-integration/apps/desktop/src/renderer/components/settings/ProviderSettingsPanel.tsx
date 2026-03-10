// apps/desktop/src/renderer/components/settings/ProviderSettingsPanel.tsx

import type { ProviderId, ConnectedProvider } from '@accomplish/shared';
import { PROVIDER_META } from '@accomplish/shared';
import {
  ClassicProviderForm,
  BedrockProviderForm,
  OllamaProviderForm,
  OpenRouterProviderForm,
  LiteLLMProviderForm,
} from './providers';

interface ProviderSettingsPanelProps {
  providerId: ProviderId;
  connectedProvider?: ConnectedProvider;
  onConnect: (provider: ConnectedProvider) => void;
  onDisconnect: () => void;
  onModelChange: (modelId: string) => void;
  showModelError: boolean;
}

export function ProviderSettingsPanel({
  providerId,
  connectedProvider,
  onConnect,
  onDisconnect,
  onModelChange,
  showModelError,
}: ProviderSettingsPanelProps) {
  const meta = PROVIDER_META[providerId];

  // Render form content based on provider category
  const renderForm = () => {
    switch (meta.category) {
      case 'classic':
        return (
          <ClassicProviderForm
            providerId={providerId}
            connectedProvider={connectedProvider}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onModelChange={onModelChange}
            showModelError={showModelError}
          />
        );

      case 'aws':
        return (
          <BedrockProviderForm
            connectedProvider={connectedProvider}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onModelChange={onModelChange}
            showModelError={showModelError}
          />
        );

      case 'local':
        return (
          <OllamaProviderForm
            connectedProvider={connectedProvider}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onModelChange={onModelChange}
            showModelError={showModelError}
          />
        );

      case 'proxy':
        return (
          <OpenRouterProviderForm
            connectedProvider={connectedProvider}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onModelChange={onModelChange}
            showModelError={showModelError}
          />
        );

      case 'hybrid':
        return (
          <LiteLLMProviderForm
            connectedProvider={connectedProvider}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onModelChange={onModelChange}
            showModelError={showModelError}
          />
        );

      default:
        return <div>Unknown provider type</div>;
    }
  };

  // Wrap in min-height container to prevent layout shifts when switching providers
  // Different forms have different heights; this ensures consistent layout
  return (
    <div className="min-h-[260px]">
      {renderForm()}
    </div>
  );
}
