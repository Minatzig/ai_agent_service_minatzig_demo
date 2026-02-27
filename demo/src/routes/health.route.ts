// ═════════════════════════════════════════════════════════════════════════════
// HEALTH ROUTE — Handles GET /healthz endpoint
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ROUTE RESPONSIBILITY: Receive HTTP request, call controller, send HTTP response
 *
 * Route: GET /healthz
 * Purpose: Health check endpoint for load balancers and orchestration systems
 *
 * This endpoint is used by:
 * - Render deployment platform for health checks
 * - Kubernetes or other container orchestrators
 * - Upstream load balancers to determine if the service is up
 *
 * Request body: None
 *
 * Response (200 OK):
 *   { "ok": true }
 */

import { Router, Request, Response } from "express";

export const healthRouter = Router();

/**
 * GET /healthz
 *
 * Simple health check endpoint that returns 200 OK if the service is running.
 * Does not require any database or external service connectivity.
 *
 * This route is responsible for:
 * - Responding quickly to health check requests
 * - Always returning 200 OK as long as the Node.js process is alive
 */
healthRouter.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});
