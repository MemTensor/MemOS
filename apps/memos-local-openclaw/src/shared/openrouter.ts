/** Shared OpenRouter request routing for OpenAI-compatible providers. */

export interface OpenRouterRoutingConfig {
  endpoint?: string;
  /** Explicitly enable OpenRouter fields for a reverse proxy or CNAME. */
  openRouter?: boolean;
  providerIgnore?: string[];
  providerOrder?: string[];
}

const OPENROUTER_HOSTS = new Set(["openrouter.ai"]);

export function applyOpenRouterProviderRouting(
  config: OpenRouterRoutingConfig,
  body: Record<string, unknown>,
): void {
  if (!isOpenRouter(config)) return;

  const provider: Record<string, unknown> = {};
  if (config.providerIgnore?.length) provider.ignore = config.providerIgnore;
  if (config.providerOrder?.length) provider.order = config.providerOrder;
  if (Object.keys(provider).length > 0) body.provider = provider;
}

function isOpenRouter(config: OpenRouterRoutingConfig): boolean {
  if (config.openRouter) return true;
  if (!config.endpoint) return false;
  try {
    return OPENROUTER_HOSTS.has(new URL(config.endpoint).hostname.toLowerCase());
  } catch {
    return false;
  }
}
