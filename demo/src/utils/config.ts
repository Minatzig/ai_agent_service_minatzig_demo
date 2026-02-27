// ═════════════════════════════════════════════════════════════════════════════
// CONFIG — Application configuration constants and environment variables
// ═════════════════════════════════════════════════════════════════════════════

import * as dotenv from "dotenv";

dotenv.config();

// ── Validate required environment variables on startup ────────────────────────────
const REQUIRED_ENV = ["GEMINI_API_KEY", "LANGSMITH_API_KEY", "DB_NAME", "DB_USER", "DB_PASSWORD"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// ── Application Metadata ──────────────────────────────────────────────────────────
export const APP_CONFIG = {
  signature: "2026-02-25-A",
  renderCommit: process.env.RENDER_GIT_COMMIT || "unknown",
  clientName: "Vicky", // Hardcoded client name used in prompts
  port: Number(process.env.PORT) || 3000,
} as const;

// ── Database Configuration ────────────────────────────────────────────────────────
// DB_SSL: set "true" or "false" to force; if absent, SSL is auto-enabled when
// running on Render (RENDER env var is always present there).
const DB_SSL = process.env.DB_SSL !== undefined
  ? process.env.DB_SSL === "true"
  : !!process.env.RENDER;

export const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: DB_SSL ? { rejectUnauthorized: false } : undefined,
} as const;

// ── LangSmith Configuration ───────────────────────────────────────────────────────
export const LANGSMITH_CONFIG = {
  apiKey: process.env.LANGSMITH_API_KEY,
  apiUrl: "https://eu.api.smith.langchain.com",
  // LangSmith prompt versions
  prompts: {
    dataChecker: "data_checker:885899c9",
    respuestaFinal: "respuesta_final:77fd31b5",
  },
} as const;

// ── Gemini Configuration ──────────────────────────────────────────────────────────
export const GEMINI_CONFIG = {
  apiKey: process.env.GEMINI_API_KEY,
  embeddingModel: "gemini-embedding-001",
  generationModel: "gemini-2.5-flash",
} as const;

// ── RAG Pipeline Configuration ────────────────────────────────────────────────────
export const RAG_CONFIG = {
  topK: 4, // Number of chunks to retrieve from vector search
} as const;

// ── Environment Detection ─────────────────────────────────────────────────────────
export const ENV = {
  isProd: process.env.NODE_ENV === "production",
  isDev: process.env.NODE_ENV !== "production",
  isRender: !!process.env.RENDER,
  sslEnabled: DB_SSL,
} as const;

// ── Logging Boot Information ──────────────────────────────────────────────────────
export function logBootInfo(): void {
  console.log(`[BOOT] rag.ts signature = ${APP_CONFIG.signature}`);
  console.log(`[BOOT] render commit = ${APP_CONFIG.renderCommit}`);
  console.log(`[BOOT] DB_SSL=${ENV.sslEnabled} host=${DB_CONFIG.host}`);
}
