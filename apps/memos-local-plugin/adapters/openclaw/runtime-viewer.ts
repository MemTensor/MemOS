/**
 * Start the optional Viewer without making its fixed HTTP port part of the
 * shared-memory runtime's availability contract.
 */
export async function startOptionalViewer<T>(
  start: () => Promise<T>,
  onPortInUse: () => void,
): Promise<T | null> {
  try {
    return await start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    onPortInUse();
    return null;
  }
}
