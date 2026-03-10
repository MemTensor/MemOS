// apps/desktop/src/renderer/components/settings/ProviderCard.tsx

import { memo, useCallback } from 'react';
import type { ProviderId, ConnectedProvider } from '@accomplish/shared';
import { PROVIDER_META, isProviderReady } from '@accomplish/shared';

// Import provider logos
import anthropicLogo from '/assets/ai-logos/anthropic.svg';
import openaiLogo from '/assets/ai-logos/openai.svg';
import googleLogo from '/assets/ai-logos/google.svg';
import xaiLogo from '/assets/ai-logos/xai.svg';
import deepseekLogo from '/assets/ai-logos/deepseek.svg';
import zaiLogo from '/assets/ai-logos/zai.svg';
import bedrockLogo from '/assets/ai-logos/bedrock.svg';
import ollamaLogo from '/assets/ai-logos/ollama.svg';
import openrouterLogo from '/assets/ai-logos/openrouter.svg';
import litellmLogo from '/assets/ai-logos/litellm.svg';

// Import connected badge icon
import connectedKeyIcon from '/assets/icons/connected-key.svg';

const PROVIDER_LOGOS: Record<ProviderId, string> = {
  anthropic: anthropicLogo,
  openai: openaiLogo,
  google: googleLogo,
  xai: xaiLogo,
  deepseek: deepseekLogo,
  zai: zaiLogo,
  bedrock: bedrockLogo,
  ollama: ollamaLogo,
  openrouter: openrouterLogo,
  litellm: litellmLogo,
};

interface ProviderCardProps {
  providerId: ProviderId;
  connectedProvider?: ConnectedProvider;
  isActive: boolean;
  isSelected: boolean;
  onSelect: (providerId: ProviderId) => void;
}

// Memoized to prevent unnecessary re-renders when switching between providers
// Only re-renders when its own props change (not when sibling cards change)
export const ProviderCard = memo(function ProviderCard({
  providerId,
  connectedProvider,
  isActive,
  isSelected,
  onSelect,
}: ProviderCardProps) {
  const meta = PROVIDER_META[providerId];
  const isConnected = connectedProvider?.connectionStatus === 'connected';
  const providerReady = isProviderReady(connectedProvider);
  const logoSrc = PROVIDER_LOGOS[providerId];

  // Green background should ONLY show for the active provider that is ready (connected + model selected)
  // isSelected just means the card is clicked for viewing settings - it should only get a border, not green background
  const showGreenBackground = isActive && providerReady;

  // Handler calls onSelect with this card's providerId
  const handleClick = useCallback(() => {
    onSelect(providerId);
  }, [onSelect, providerId]);

  return (
    <button
      onClick={handleClick}
      data-testid={`provider-card-${providerId}`}
      className={`relative flex flex-col items-center justify-center rounded-xl border p-4 w-[130px] h-[110px] transition-[background-color,border-color] duration-150 ${
        showGreenBackground
          ? 'border-[#4a4330] border-2 bg-[#e9f7e7]'
          : isSelected
            ? 'border-[#4a4330] border-2 bg-[#f9f8f6]'
            : 'border-border bg-[#f9f8f6] hover:border-ring'
      }`}
    >
      {/* Connection status badge - always green when connected */}
      {isConnected && (
        <div className="absolute top-2 right-2" data-testid={`provider-connected-badge-${providerId}`}>
          <img
            src={connectedKeyIcon}
            alt={providerReady ? "Ready" : "Connected"}
            className="h-5 w-5"
            title={providerReady ? undefined : "Select a model to complete setup"}
          />
        </div>
      )}

      {/* Provider Logo */}
      <div className="mb-2 h-10 w-10 flex items-center justify-center">
        <img
          src={logoSrc}
          alt={`${meta.name} logo`}
          className="h-8 w-8 object-contain"
        />
      </div>

      {/* Name */}
      <span className="text-sm font-medium text-foreground">
        {meta.name}
      </span>

      {/* Label */}
      <span className="text-xs text-muted-foreground">
        {meta.label}
      </span>
    </button>
  );
});
