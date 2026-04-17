// ═════════════════════════════════════════════════════════════════════════════
// ASYNC — Timeout and retry helpers for external calls
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Races a promise against a timeout. If the timeout fires first, throws an
 * error labelled with the call site and elapsed time.
 *
 * The underlying promise is NOT cancelled — this only stops the caller from
 * waiting. For network calls without native cancellation, the request keeps
 * running in the background but its result is discarded.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  const started = Date.now();
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`[timeout] ${label} exceeded ${ms}ms (elapsed=${Date.now() - started}ms)`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Retries the given async function up to `retries` times with a fixed delay
 * between attempts. Each retry is logged with reqId and stage for traceability.
 *
 * `retries = 1` means: try once, on failure wait delayMs, try once more, then
 * surface the final error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; delayMs: number; stage: string; reqId?: string }
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < opts.retries) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[RAG] reqId=${opts.reqId ?? "-"} stage=${opts.stage} retry=${attempt + 1}/${opts.retries} error="${msg}"`
        );
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
    }
  }
  throw lastErr;
}
