import { useEffect, useState } from "preact/hooks";

import { api } from "../api/client";
import { triggerRestart } from "../stores/restart";

interface ResolvedConfig {
  algorithm?: {
    lightweightMemory?: {
      enabled?: boolean;
    };
  };
}

export interface LightweightMemoryModeState {
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function useLightweightMemoryMode(): LightweightMemoryModeState {
  const [enabled, setEnabledState] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<ResolvedConfig>("/api/v1/config", { signal: ctrl.signal })
      .then((cfg) => {
        setEnabledState(cfg.algorithm?.lightweightMemory?.enabled === true);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") {
          setEnabledState(false);
          setError((err as Error).message);
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  const setEnabled = async (next: boolean) => {
    if (saving || next === enabled) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch<ResolvedConfig>("/api/v1/config", {
        algorithm: { lightweightMemory: { enabled: next } },
      });
      await triggerRestart();
      setEnabledState(next);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  return { enabled, loading, saving, error, setEnabled };
}
