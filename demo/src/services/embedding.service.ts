// ═════════════════════════════════════════════════════════════════════════════
// EMBEDDING SERVICE — Handles vector embeddings and similarity search
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ResponsibilityService Layer:
 * - Generate embeddings using Gemini API
 * - Perform vector similarity search in the database
 * - Manage embedding dimension alignment between model and database
 *
 * This service abstracts all database and external API calls related to embeddings.
 * Controllers will call these functions to retrieve relevant documents.
 */

import { db } from "../utils/database";
import { sql } from "drizzle-orm";
import { GEMINI_CONFIG, RAG_CONFIG, ENV } from "../utils/config";
import { GoogleGenAI } from "@google/genai";
import { Chunk } from "../utils/types";

// ── Gemini Client Setup ───────────────────────────────────────────────────────
// Initialize the Gemini client for embeddings
const geminiClient = new GoogleGenAI({ apiKey: GEMINI_CONFIG.apiKey! });
const gemini = geminiClient;

// ── Dimension Management ──────────────────────────────────────────────────────
let EFFECTIVE_DIM      = 0;      // Actual embedding dimension in the database
let TRUNCATE_EMBEDDING = false;  // Whether to truncate embeddings before search

/**
 * Detects and validates the embedding dimension alignment between the database
 * and the Gemini embedding model.
 *
 * In production, a mismatch causes a fatal error.
 * In development, embeddings are truncated if the model output is larger.
 *
 * Call this once during application startup.
 */
export async function detectDimensions(): Promise<void> {
  // Query the database to find the embedding column dimension
  const colResult = await db.execute(sql`
    SELECT format_type(atttypid, atttypmod) AS col_type
    FROM   pg_attribute
    WHERE  attrelid = 'document_chunks'::regclass
      AND  attname  = 'embedding'
      AND  attnum   > 0
  `);

  const colType  = (colResult.rows[0] as any)?.col_type as string ?? "";
  const dimMatch = /vector\((\d+)\)/.exec(colType);

  if (!dimMatch) {
    throw new Error(
      `[startup] Cannot parse embedding column type from DB (got: "${colType}"). ` +
      `Ensure the document_chunks table exists with an 'embedding vector(N)' column.`
    );
  }

  EFFECTIVE_DIM = parseInt(dimMatch[1], 10);

  // Probe the Gemini model to get its actual output dimension
  const probeResp = await gemini.models.embedContent({
    model: GEMINI_CONFIG.embeddingModel,
    contents: "dimension probe",
  });
  const modelDim = probeResp.embeddings![0].values!.length;

  console.log(
    `[startup] DB embedding column: ${colType} → ${EFFECTIVE_DIM} dims | ` +
    `${GEMINI_CONFIG.embeddingModel} output: ${modelDim} dims`
  );

  if (EFFECTIVE_DIM === modelDim) {
    console.log(`[startup] Dimension alignment ✓ — no adjustment needed`);
    return;
  }

  const isProd = ENV.isProd;

  if (isProd) {
    // In production, a mismatch is fatal — data consistency is critical
    throw new Error(
      `[startup] FATAL: embedding dimension mismatch in production. ` +
      `DB column is vector(${EFFECTIVE_DIM}) but ${GEMINI_CONFIG.embeddingModel} produces ${modelDim} dims. ` +
      `Fix options: (1) ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(${modelDim}) ` +
      `and re-ingest all documents, or (2) switch to a model that outputs ${EFFECTIVE_DIM} dims.`
    );
  }

  // In development: truncate if model output > DB column size
  if (modelDim > EFFECTIVE_DIM) {
    TRUNCATE_EMBEDDING = true;
    console.warn(
      `[startup] ⚠️  DEV mode — model output (${modelDim} dims) > DB column (${EFFECTIVE_DIM} dims). ` +
      `Embeddings will be TRUNCATED to ${EFFECTIVE_DIM} dims before vector search. ` +
      `This reduces semantic quality. For production, re-ingest with the correct dimension.`
    );
  } else {
    // Model dimension < DB column: padding is semantically unsafe
    throw new Error(
      `[startup] Embedding dimension mismatch: DB column expects ${EFFECTIVE_DIM} dims ` +
      `but model produces only ${modelDim} dims. Padding is not safe. ` +
      `Fix: ALTER the column to vector(${modelDim}) and re-ingest, or use a model that outputs ${EFFECTIVE_DIM} dims.`
    );
  }
}

/**
 * Generates a vector embedding for the given question using Gemini API.
 *
 * SERVICE RESPONSIBILITY: Call external embedding API
 *
 * @param question - The text to embed
 * @returns A vector of floating-point numbers (768 dimensions for Gemini)
 */
export async function embedQuestion(question: string): Promise<number[]> {
  const response = await gemini.models.embedContent({
    model: GEMINI_CONFIG.embeddingModel,
    contents: question,
  });

  let vec = response.embeddings![0].values!;

  // Truncate if necessary (DEV mode only)
  if (TRUNCATE_EMBEDDING && vec.length > EFFECTIVE_DIM) {
    vec = vec.slice(0, EFFECTIVE_DIM);
  }

  return vec;
}

/**
 * Performs vector similarity search in the document_chunks table.
 * Returns the top K chunks most similar to the given embedding vector.
 *
 * SERVICE RESPONSIBILITY: Query the database for semantically similar documents
 *
 * @param embedding - Vector embedding to search for
 * @param topK - Number of chunks to retrieve
 * @returns Array of document chunks sorted by similarity (highest first)
 */
export async function retrieveChunks(embedding: number[], topK: number = RAG_CONFIG.topK): Promise<Chunk[]> {
  // Format embedding as PostgreSQL vector string
  const vectorStr = `[${embedding.join(",")}]`;

  console.log(
    `[vector_search] embedding_len=${embedding.length} EFFECTIVE_DIM=${EFFECTIVE_DIM} ` +
    `TRUNCATE_EMBEDDING=${TRUNCATE_EMBEDDING} ` +
    `vectorStr_preview=[${embedding.slice(0, 3).join(",")}...]`
  );

  // Use PostgreSQL cosine distance operator (<=>)to find similar chunks
  const result = await db.execute(sql`
    SELECT
      chunk_id,
      source_file,
      section_title,
      text,
      1 - (embedding <=> ${vectorStr}::vector) AS similarity
    FROM document_chunks
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${topK}
  `);

  return result.rows as unknown as Chunk[];
}

/**
 * Fetches specific document chunks by their IDs directly from the database.
 * Used by controllers to retrieve chunks selected by the data_checker stage.
 *
 * SERVICE RESPONSIBILITY: Direct database query by primary key
 *
 * @param ids - Array of chunk IDs to fetch
 * @returns Array of document chunks matching the provided IDs
 */
export async function fetchChunksByIds(ids: string[]): Promise<Chunk[]> {
  if (ids.length === 0) return [];

  const result = await db.execute(sql`
    SELECT
      chunk_id,
      source_file,
      section_title,
      text,
      0 AS similarity
    FROM document_chunks
    WHERE chunk_id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[])
  `);

  const chunks = result.rows as unknown as Chunk[];
  console.log(`🔎 Fetched ${chunks.length}/${ids.length} chunks by ID from DB`);
  return chunks;
}
