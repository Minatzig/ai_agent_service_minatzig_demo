// ═════════════════════════════════════════════════════════════════════════════
// LOGGER — Structured logging utility for debugging and tracing requests
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Generates a random 6-character ID for request tracing.
 * Used in logs for end-to-end request tracking.
 */
export function genId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Logs a structured message with request ID and stage information.
 * All logs are prefixed with [RAG] for easy grepping in log viewers (e.g., Render).
 *
 * @param reqId - Unique request identifier for tracing
 * @param stage - Current pipeline stage (e.g., "embedding_start", "vector_search_done")
 * @param extra - Additional key-value pairs to include in the log
 */
export function log(reqId: string, stage: string, extra: Record<string, string | number> = {}): void {
  const parts = [`[RAG] reqId=${reqId}`, `stage=${stage}`];
  for (const [k, v] of Object.entries(extra)) {
    parts.push(`${k}=${v}`);
  }
  console.log(parts.join(" "));
}

/**
 * Logs an error with error details, stack trace, and request context.
 * Useful for debugging failures in the RAG pipeline.
 *
 * @param reqId - Unique request identifier for tracing
 * @param stage - Pipeline stage where the error occurred
 * @param err - The error object or message
 */
export function logError(reqId: string, stage: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack ?? "") : "";
  console.error(`[RAG] reqId=${reqId} stage=${stage} ERROR message="${message}"\n${stack}`);
}
