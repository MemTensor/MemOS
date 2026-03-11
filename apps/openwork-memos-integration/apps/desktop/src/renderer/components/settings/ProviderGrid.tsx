// apps/desktop/src/renderer/components/settings/ProviderGrid.tsx

import { useState, useMemo, useCallback } from 'react';
import type { ProviderId, ProviderSettings } from '@accomplish/shared';
import { PROVIDER_META } from '@accomplish/shared';
import { ProviderCard } from './ProviderCard';

// Provider order matching Figma design (4 columns per row)
const PROVIDER_ORDER: ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'bedrock',
  'deepseek',
  'zai',
  'ollama',
  'xai',
  'openrouter',
  'litellm',
];

interface ProviderGridProps {
  settings: ProviderSettings;
  selectedProvider: ProviderId | null;
  onSelectProvider: (providerId: ProviderId) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}

export function ProviderGrid({
  settings,
  selectedProvider,
  onSelectProvider,
  expanded,
  onToggleExpanded,
}: ProviderGridProps) {
  const [search, setSearch] = useState('');

  const filteredProviders = useMemo(() => {
    if (!search.trim()) return PROVIDER_ORDER;
    const query = search.toLowerCase();
    return PROVIDER_ORDER.filter(id => {
      const meta = PROVIDER_META[id];
      return meta.name.toLowerCase().includes(query);
    });
  }, [search]);

  return (
    <div className="rounded-xl border border-border bg-[#edebe7] p-4" data-testid="provider-grid">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-foreground">Providers</span>
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Providers"
            data-testid="provider-search-input"
            className="w-48 rounded-md border border-input bg-background pl-9 pr-3 py-1.5 text-sm"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Providers - min-h prevents layout shift when switching between providers */}
      {expanded ? (
        /* Expanded: show all in grid with min-height to prevent flickering */
        <div className="grid grid-cols-4 gap-3 min-h-[280px] justify-items-center">
          {filteredProviders.map(providerId => (
            <ProviderCard
              key={providerId}
              providerId={providerId}
              connectedProvider={settings?.connectedProviders?.[providerId]}
              isActive={settings?.activeProviderId === providerId}
              isSelected={selectedProvider === providerId}
              onSelect={onSelectProvider}
            />
          ))}
        </div>
      ) : (
        /* Collapsed: single row, 4 providers */
        <div className="grid grid-cols-4 gap-3 justify-items-center">
          {filteredProviders.slice(0, 4).map(providerId => (
            <ProviderCard
              key={providerId}
              providerId={providerId}
              connectedProvider={settings?.connectedProviders?.[providerId]}
              isActive={settings?.activeProviderId === providerId}
              isSelected={selectedProvider === providerId}
              onSelect={onSelectProvider}
            />
          ))}
        </div>
      )}

      {/* Show All / Hide toggle */}
      <div className="mt-4 text-center border-t border-border pt-3">
        <button
          onClick={onToggleExpanded}
          className="text-sm text-muted-foreground hover:text-foreground font-medium"
          data-testid="show-all-toggle"
        >
          {expanded ? 'Hide' : 'Show All'}
        </button>
      </div>
    </div>
  );
}
