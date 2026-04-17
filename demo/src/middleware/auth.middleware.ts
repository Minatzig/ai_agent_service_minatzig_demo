// ═════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE — Bearer-token check for protected endpoints
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Behaviour:
 * - If AI_SERVICE_SECRET is empty, the middleware is a no-op (open mode).
 *   A single warning is logged at startup via logAuthWarningOnce().
 * - If set, the request must include `Authorization: Bearer <secret>`.
 *   Any mismatch returns 401 { error: "Unauthorized" }.
 *
 * Applied to /ask and /v1/resolve only. /healthz is always open.
 */

import { Request, Response, NextFunction } from "express";
import { APP_CONFIG } from "../utils/config";

let warned = false;

/**
 * Emits a single startup warning if AI_SERVICE_SECRET is unset.
 * Call this from the startup sequence.
 */
export function logAuthWarningOnce(): void {
  if (APP_CONFIG.aiServiceSecret) return;
  if (warned) return;
  warned = true;
  console.warn(
    "[auth] ⚠️  AI_SERVICE_SECRET is not set — /ask and /v1/resolve are OPEN. " +
      "Set AI_SERVICE_SECRET to require Bearer auth."
  );
}

/**
 * Express middleware that enforces Authorization: Bearer <AI_SERVICE_SECRET>
 * when the secret is configured. In open mode (no secret), it passes through.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = APP_CONFIG.aiServiceSecret;
  if (!secret) {
    return next();
  }

  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
