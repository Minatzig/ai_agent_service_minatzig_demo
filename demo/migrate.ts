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
  ssl: process.env.DB_SSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

const db = drizzle(pool);

async function migrate() {
  console.log("Enabling pgvector extension...");
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  console.log("Dropping existing document_chunks table if it exists...");
  try {
    await db.execute(sql`DROP TABLE IF EXISTS document_chunks CASCADE`);
  } catch (err) {
    console.log("Table didn't exist - that's OK");
  }

  console.log("Creating document_chunks table with vector(768)...");
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

  console.log("Creating vector search index...");
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
    ON document_chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
  `);

  console.log("✅ Migration complete!");
  await pool.end();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
