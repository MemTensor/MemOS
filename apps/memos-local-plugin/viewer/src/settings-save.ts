/** Persist settings, publish the canonical server response, then restart. */
export async function saveSettingsAndRestart<TPatch, TConfig>(
  patch: TPatch,
  persist: (patch: TPatch) => Promise<TConfig>,
  applySaved: (config: TConfig) => void,
  restart: () => Promise<void>,
): Promise<TConfig> {
  const saved = await persist(patch);
  applySaved(saved);
  await restart();
  return saved;
}
