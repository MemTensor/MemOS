import { signal } from "@preact/signals";
import { api } from "../api/client";

export type ShareScope = "private" | "public" | "hub";
export type LegacyShareScope = ShareScope | "local";

export const SHARE_SCOPE_OPTIONS = ["private", "public", "hub"] as const satisfies readonly ShareScope[];

interface SharingConfig {
  hub?: {
    enabled?: boolean;
  };
}

export const hubSharingEnabled = signal(false);

let pendingConfigLoad: Promise<void> | null = null;

/**
 * The persisted per-item share scope records the user's intent. The
 * effective scope is what the viewer may show right now under the
 * global team-sharing switch.
 */
export function effectiveShareScope(
  scope: LegacyShareScope | null | undefined,
  sharingEnabled = hubSharingEnabled.value,
): ShareScope {
  const intendedScope = normalizeShareScope(scope);
  return sharingEnabled ? intendedScope : "private";
}

export function normalizeShareScope(scope: LegacyShareScope | null | undefined): ShareScope {
  if (scope === "local") return "public";
  if (scope === "public" || scope === "hub") return scope;
  return "private";
}

export async function loadHubSharingEnabled({
  force = false,
  signal,
}: {
  force?: boolean;
  signal?: AbortSignal;
} = {}): Promise<void> {
  if (pendingConfigLoad && !force) return pendingConfigLoad;

  pendingConfigLoad = api
    .get<SharingConfig>("/api/v1/config", { signal })
    .then((config) => {
      hubSharingEnabled.value = !!config.hub?.enabled;
    })
    .catch((err) => {
      if ((err as Error).name === "AbortError") return;
      hubSharingEnabled.value = false;
    })
    .finally(() => {
      pendingConfigLoad = null;
    });

  return pendingConfigLoad;
}
