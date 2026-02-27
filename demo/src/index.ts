// ═════════════════════════════════════════════════════════════════════════════
// MAIN APPLICATION — Express server setup and initialization
// ═════════════════════════════════════════════════════════════════════════════

/**
 * This file:
 * 1. Imports and registers all routes
 * 2. Configures Express middleware
 * 3. Initializes database and embedding dimensions
 * 4. Starts the HTTP server
 *
 * ARCHITECTURE:
 *
 *              HTTP Request
 *                   ↓
 *              ROUTES Layer
 *           (HTTP parsing & validation)
 *                   ↓
 *           CONTROLLERS Layer
 *       (Business logic orchestration)
 *                   ↓
 *           SERVICES Layer
 *     (Database & external API calls)
 *                   ↓
 *              Database / APIs
 *         (Postgres, Gemini, LangSmith)
 */

import express from "express";
import { askRouter } from "./routes/ask.route";
import { resolveRouter } from "./routes/resolve.route";
import { healthRouter } from "./routes/health.route";
import { checkDB } from "./utils/database";
import { detectDimensions } from "./services/embedding.service";
import { APP_CONFIG, logBootInfo } from "./utils/config";

// ── Initialize Express application ────────────────────────────────────────────
const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
// Parse incoming JSON request bodies
app.use(express.json());

// ── Register Routes ───────────────────────────────────────────────────────────
// Mount all route handlers
app.use(healthRouter);    // GET /healthz
app.use(askRouter);       // POST /ask
app.use(resolveRouter);   // POST /v1/resolve

// ── Startup Sequence ──────────────────────────────────────────────────────────

/**
 * Performs all startup checks and initializations:
 * 1. Validates database connectivity
 * 2. Detects and aligns embedding dimensions
 */
async function startup(): Promise<void> {
  // Log boot information
  logBootInfo();

  // Check database connectivity and schema
  await checkDB();

  // Detect embedding dimension alignment between DB and Gemini model
  await detectDimensions();

  // Start listening for HTTP requests
  const PORT = APP_CONFIG.port;
  app.listen(PORT, () => {
    console.log(`🚀 RAG server running on http://localhost:${PORT}`);
    console.log(`   POST /ask  { "question": "your question here" }`);
    console.log(`   POST /v1/resolve  { "text": "your question here" }`);
    console.log(`   GET  /healthz`);
  });
}

// Execute startup sequence
startup().catch((err) => {
  console.error("[startup] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export default app;
