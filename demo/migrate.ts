// migrate.ts
// Run this ONCE to enable pgvector and create the table
// npx ts-node migrate.ts

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import * as dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // No SSL needed for local Postgres
});

const db = drizzle(pool);

async function migrate() {
  console.log("Enabling pgvector extension...");
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  console.log("Creating document_chunks table...");
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS document_chunks (
      chunk_id        TEXT PRIMARY KEY,
      source_file     TEXT NOT NULL,
      doc_type        TEXT,
      section_title   TEXT,
      chunk_index     INTEGER,
      self_contained  BOOLEAN,
      missing_context TEXT,
      summary         TEXT,
      text            TEXT NOT NULL,
      embed_input     TEXT,
      embedding       vector(768),
      created_at      TIMESTAMPTZ DEFAULT now()
    )
  `);

  console.log("Creating HNSW index for fast vector search...");
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
    ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
  `);

  console.log("✅ Migration complete!");
  await pool.end();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
