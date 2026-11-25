/** Optional metadata-only diagnostics. Recording must never change runtime behavior. */
export type DiagnosticSink = (event: string, fields: Record<string, unknown>) => void;

export function emitDiagnostic(sink: DiagnosticSink | undefined, event: string, fields: Record<string, unknown>): void {
  try { sink?.(event, fields); } catch { /* diagnostics are best-effort */ }
}

/** Preserve native DSH codes, without exporting arbitrary provider response bodies. */
export function diagnosticError(error: unknown): { errorCode: string; errorName: string } {
  const value = error as { code?: unknown; name?: unknown; details?: { dshCode?: unknown } } | null;
  const code = value?.details?.dshCode ?? value?.code;
  return {
    errorCode: typeof code === "string" ? code : value?.name === "TimeoutError" ? "TIMEOUT" : value?.name === "AbortError" ? "ABORTED" : "UNKNOWN",
    errorName: typeof value?.name === "string" ? value.name : "Error",
  };
}

/** A configured filter cap never extends the caller's absolute deadline. */
export function retrievalFilterTimeoutMs(deadlineAt?: number, capMs = 2_000): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(1, Math.min(capMs, deadlineAt - Date.now()));
}
