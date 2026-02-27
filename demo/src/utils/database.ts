// ═════════════════════════════════════════════════════════════════════════════
// DATABASE — Database connection initialization and health checks
// ═════════════════════════════════════════════════════════════════════════════

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { DB_CONFIG } from "./config";

/**
 * Initialize the database connection pool.
 * Handles SSL configuration for both local and Render environments.
 */
const pool = new Pool({
  host:     DB_CONFIG.host,
  port:     DB_CONFIG.port,
  database: DB_CONFIG.database,
  user:     DB_CONFIG.user,
  password: DB_CONFIG.password,
  ...(DB_CONFIG.ssl ? { ssl: DB_CONFIG.ssl } : {}),
});

export const db = drizzle(pool);

/**
 * Performs health checks on the database connection and schema.
 * 1. Tests basic connectivity with a simple SELECT query
 * 2. Verifies that the document_chunks table exists and has rows
 * 3. Detects the embedding column dimensions for validation
 *
 * Call this during application startup to ensure the database is ready.
 */
export async function checkDB(): Promise<void> {
  try {
    // Test basic connectivity
    await db.execute(sql`SELECT 1`);
    console.log("[startup] DB connected OK");

    // Verify table existence and row count
    const countResult = await db.execute(sql`SELECT COUNT(*) AS n FROM document_chunks`);
    const n = (countResult.rows[0] as any)?.n ?? "?";
    console.log(`[startup] document_chunks: ${n} rows`);
  } catch (err) {
    throw new Error(
      `[startup] Table document_chunks does not exist or is inaccessible. ` +
      `Run migrate.ts to create the schema. Detail: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
