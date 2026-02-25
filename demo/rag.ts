// rag.ts
// Express RAG endpoint — two-stage pipeline:
//   Stage 1 — data_checker:    selects up to 2 relevant docs from top 5 retrieved chunks
//   Stage 2 — respuesta_final: generates final answer using ONLY the docs selected by data_checker
//
// Dependencies:
//   npm install express pg drizzle-orm @google/genai langchain @langchain/core langsmith dotenv
//   npm install -D @types/express @types/pg ts-node typescript

import express, { Request, Response } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { GoogleGenAI } from "@google/genai";
import * as hub from "langchain/hub/node";
import { wrapGemini } from "langsmith/wrappers/gemini";
import * as dotenv from "dotenv";

dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────────────

const CLIENT_NAME            = "Vicky";                              // ← Hardcoded client name
const PROMPT_DATA_CHECKER    = "data_checker:885899c9";    // ← data_checker commit
const PROMPT_RESPUESTA_FINAL = "respuesta_final:fca2401d"; // ← respuesta_final commit
const TOP_K                  = 5;
const NO_ANSWER_MESSAGE      = "Esta pregunta debe ser contestada por un humano.";
const LANGSMITH_API_URL      = "https://eu.api.smith.langchain.com";

// ── Validate required env vars on startup ─────────────────────────────────────

const REQUIRED_ENV = ["GEMINI_API_KEY", "LANGSMITH_API_KEY", "DB_NAME", "DB_USER", "DB_PASSWORD"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const db = drizzle(pool);

// ── Gemini (wrapped for LangSmith tracing) ────────────────────────────────────

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const gemini       = wrapGemini(geminiClient);

// ── Embedding dimension alignment ─────────────────────────────────────────────
// At startup we query the DB for the actual vector column dimension and probe
// the embedding model. If they mismatch we adapt (DEV: truncate) or abort (PROD).

let EFFECTIVE_DIM      = 0;      // dimension of document_chunks.embedding, from DB
let TRUNCATE_EMBEDDING = false;  // true when model output is truncated in DEV

async function detectDimensions(): Promise<void> {
  // Query the exact type of the embedding column so we know the DB dimension.
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

  // Probe the model to find its actual output dimension.
  const probeResp = await gemini.models.embedContent({
    model:    "gemini-embedding-001",
    contents: "dimension probe",
  });
  const modelDim = probeResp.embeddings![0].values!.length;

  console.log(
    `[startup] DB embedding column: ${colType} → ${EFFECTIVE_DIM} dims | ` +
    `gemini-embedding-001 output: ${modelDim} dims`
  );

  if (EFFECTIVE_DIM === modelDim) {
    console.log(`[startup] Dimension alignment ✓ — no adjustment needed`);
    return;
  }

  const isProd = process.env.NODE_ENV === "production";

  if (isProd) {
    throw new Error(
      `[startup] FATAL: embedding dimension mismatch in production. ` +
      `DB column is vector(${EFFECTIVE_DIM}) but gemini-embedding-001 produces ${modelDim} dims. ` +
      `Fix options: (1) ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(${modelDim}) ` +
      `and re-ingest all documents, or (2) switch to a model that outputs ${EFFECTIVE_DIM} dims.`
    );
  }

  // DEV only: truncate if model output is longer than what the DB column holds.
  if (modelDim > EFFECTIVE_DIM) {
    TRUNCATE_EMBEDDING = true;
    console.warn(
      `[startup] ⚠️  DEV mode — model output (${modelDim} dims) > DB column (${EFFECTIVE_DIM} dims). ` +
      `Embeddings will be TRUNCATED to ${EFFECTIVE_DIM} dims before vector search. ` +
      `This reduces semantic quality. For production, re-ingest with the correct dimension.`
    );
  } else {
    // Model is shorter than DB column — padding with zeros is semantically unsafe.
    throw new Error(
      `[startup] Embedding dimension mismatch: DB column expects ${EFFECTIVE_DIM} dims ` +
      `but model produces only ${modelDim} dims. Padding is not safe. ` +
      `Fix: ALTER the column to vector(${modelDim}) and re-ingest, or use a model that outputs ${EFFECTIVE_DIM} dims.`
    );
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Chunk {
  chunk_id:      string;
  source_file:   string;
  section_title: string;
  text:          string;
  similarity:    number;
}

interface RelevantDocument {
  id:     string;
  reason: string;
}

interface DataCheckerResponse {
  relevant_documents: RelevantDocument[];
}

interface FinalAnswerResponse {
  logica:         string;
  docuementacion: string; // matches typo in LangSmith prompt intentionally
  respuesta:      string;
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embedQuestion(question: string): Promise<number[]> {
  const response = await gemini.models.embedContent({
    model:    "gemini-embedding-001",
    contents: question,
  });
  let vec = response.embeddings![0].values!;
  if (TRUNCATE_EMBEDDING && vec.length > EFFECTIVE_DIM) {
    vec = vec.slice(0, EFFECTIVE_DIM);
  }
  return vec;
}

// ── Vector search ─────────────────────────────────────────────────────────────

async function retrieveChunks(embedding: number[], topK: number): Promise<Chunk[]> {
  const vectorStr = `[${embedding.join(",")}]`;

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

// ── Fetch chunks by IDs directly from DB ─────────────────────────────────────

async function fetchChunksByIds(ids: string[]): Promise<Chunk[]> {
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

// ── Document formatting ───────────────────────────────────────────────────────

function formatChunks(chunks: Chunk[]): string {
  return chunks.map((c) =>
    `DOCUMENT_ID: ${c.chunk_id}
Source: ${c.source_file} > ${c.section_title}
Content: ${c.text}
END_DOCUMENT_ID: ${c.chunk_id}`
  ).join("\n\n---\n\n");
}

// ── Prompt: pull from LangSmith, invoke with variables, extract all messages ──
// LangSmith prompts are ChatPromptTemplates with SYSTEM + HUMAN messages.
// We must extract each message individually and concatenate them,
// otherwise only the HUMAN message gets sent to Gemini and the
// SYSTEM prompt (which contains the documents) is lost.

async function buildPrompt(
  promptName: string,
  vars: Record<string, string>
): Promise<string> {
  const prompt = await hub.pull(promptName, {
    apiKey: process.env.LANGSMITH_API_KEY,
    apiUrl: LANGSMITH_API_URL,
  });

  const promptValue = await (prompt as any).invoke(vars);

  // Extract all messages from the ChatPromptValue
  const messages = promptValue.messages || promptValue.toChatMessages?.() || [];

  if (messages.length > 0) {
    const filled = messages
      .map((m: any) => {
        const role    = m._getType?.() || m.role || "human";
        const content = m.content || "";
        return `${role.toUpperCase()}: ${content}`;
      })
      .join("\n\n");

    console.log(`📝 Prompt "${promptName}" filled (first 500 chars):\n`, filled.slice(0, 500));
    return filled;
  }

  // Fallback if no messages found
  const filled = promptValue.toString();
  console.log(`📝 Prompt "${promptName}" filled (fallback, first 500 chars):\n`, filled.slice(0, 500));
  return filled;
}

// ── Gemini call ───────────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
  const response = await gemini.models.generateContent({
    model:    "gemini-2.5-flash",
    contents: prompt,
  });
  return response.text ?? "";
}

function parseJSON<T>(raw: string): T {
  const cleaned = raw.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned) as T;
}

// ── Debug logging helpers ──────────────────────────────────────────────────────
// All structured logs are prefixed [RAG] for easy grepping in Render log viewer.

function genId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function log(reqId: string, stage: string, extra: Record<string, string | number> = {}): void {
  const parts = [`[RAG] reqId=${reqId}`, `stage=${stage}`];
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
  console.log(parts.join(" "));
}

function logError(reqId: string, stage: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack ?? "") : "";
  console.error(`[RAG] reqId=${reqId} stage=${stage} ERROR message="${message}"\n${stack}`);
}

// ── Stage 1: data_checker ─────────────────────────────────────────────────────

async function runDataChecker(
  question: string,
  chunks: Chunk[]
): Promise<DataCheckerResponse | null> {
  const filledPrompt = await buildPrompt(PROMPT_DATA_CHECKER, {
    question,
    retrieved_document: formatChunks(chunks),
  });

  const raw     = await callGemini(filledPrompt);
  const cleaned = raw.trim().replace(/```json|```/g, "").trim();

  console.log(`🤖 data_checker raw response:`, cleaned.slice(0, 300));

  if (cleaned === "null" || cleaned === "") {
    return null;
  }

  try {
    return parseJSON<DataCheckerResponse>(cleaned);
  } catch {
    console.warn("⚠️  data_checker did not return valid JSON:", cleaned.slice(0, 100));
    return null;
  }
}

// ── Stage 2: respuesta_final ──────────────────────────────────────────────────

async function runRespuestaFinal(
  question: string,
  relevantChunks: Chunk[]
): Promise<FinalAnswerResponse> {
  const filledPrompt = await buildPrompt(PROMPT_RESPUESTA_FINAL, {
    question,
    retrieved_document: formatChunks(relevantChunks),
    client_name:        CLIENT_NAME,
    mensaje_original:   question,  // will be replaced with real message when conversation layer is built
    contexto:           "",        // will be replaced with real context when conversation layer is built
  });

  const raw = await callGemini(filledPrompt);

  try {
    return parseJSON<FinalAnswerResponse>(raw);
  } catch {
    console.warn("⚠️  respuesta_final did not return valid JSON:", raw.trim().slice(0, 100));
    return {
      logica:         "Respuesta generada directamente.",
      docuementacion: "",
      respuesta:      raw.trim(),
    };
  }
}

// ── Express route ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check — used by Render and any upstream load balancer.
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/ask", async (req: Request, res: Response) => {
  const reqId  = (req.body?.MessageSid as string | undefined) || genId();
  const tTotal = Date.now();
  const { question } = req.body as { question?: string };

  log(reqId, "request_received", { method: "POST", path: "/ask" });

  if (!question?.trim()) {
    return res.status(400).json({ error: "Missing or empty 'question' in request body" });
  }

  log(reqId, "input_validated");

  try {
    console.log(`\n❓ Question: ${question}`);

    // 1. Embed question
    log(reqId, "embedding_start");
    const tEmbed = Date.now();
    const embedding = await embedQuestion(question);
    log(reqId, "embedding_done", { durationMs: Date.now() - tEmbed, dims: embedding.length });

    // 2. Retrieve top 5 chunks by vector similarity
    log(reqId, "vector_search_start");
    const tVec = Date.now();
    const chunks = await retrieveChunks(embedding, TOP_K);
    log(reqId, "vector_search_done", { durationMs: Date.now() - tVec, rows: chunks.length });
    console.log(`📚 Retrieved ${chunks.length} chunks:`);
    chunks.forEach((c) =>
      console.log(`   - [${c.chunk_id}] ${c.section_title} (${Number(c.similarity).toFixed(3)})`)
    );

    // 3. Stage 1 — data_checker selects relevant document IDs
    console.log(`\n🔍 Running data_checker...`);
    log(reqId, "data_checker_start");
    const tChecker = Date.now();
    const checkerResult = await runDataChecker(question, chunks);
    log(reqId, "data_checker_done", { durationMs: Date.now() - tChecker, selected: checkerResult?.relevant_documents?.length ?? 0 });

    // 4. Escalate if no relevant documents found
    if (!checkerResult?.relevant_documents?.length) {
      console.log(`⚠️  No relevant documents — escalating to human`);
      log(reqId, "response_sent", { status: 200, totalMs: Date.now() - tTotal });
      return res.json({
        answer:    NO_ANSWER_MESSAGE,
        sources:   [],
        escalated: true,
      });
    }

    const selectedIds = checkerResult.relevant_documents.map((d) => d.id);
    console.log(`✅ data_checker selected IDs:`, selectedIds);

    // 5. Fetch selected chunks directly from DB by ID
    log(reqId, "chunk_fetch_start", { ids: selectedIds.length });
    const tFetch = Date.now();
    const relevantChunks = await fetchChunksByIds(selectedIds);
    log(reqId, "chunk_fetch_done", { durationMs: Date.now() - tFetch, rows: relevantChunks.length });

    if (relevantChunks.length === 0) {
      console.warn(`⚠️  No chunks found in DB for selected IDs — escalating to human`);
      log(reqId, "response_sent", { status: 200, totalMs: Date.now() - tTotal });
      return res.json({
        answer:    NO_ANSWER_MESSAGE,
        sources:   [],
        escalated: true,
      });
    }

    console.log(`📄 Passing to respuesta_final:`);
    relevantChunks.forEach((c) =>
      console.log(`   - [${c.chunk_id}] ${c.section_title}`)
    );

    // 6. Stage 2 — respuesta_final generates answer from selected docs only
    console.log(`\n💬 Running respuesta_final...`);
    log(reqId, "final_answer_start");
    const tFinal = Date.now();
    const finalAnswer = await runRespuestaFinal(question, relevantChunks);
    log(reqId, "final_answer_done", { durationMs: Date.now() - tFinal });
    console.log(`✅ Answer generated`);

    // 7. Return structured response
    log(reqId, "response_sent", { status: 200, totalMs: Date.now() - tTotal });
    return res.json({
      answer:    finalAnswer.respuesta,
      logic:     finalAnswer.logica,
      citation:  finalAnswer.docuementacion,
      sources:   relevantChunks.map((c) => ({
        chunk_id:      c.chunk_id,
        section_title: c.section_title,
        source_file:   c.source_file,
      })),
      escalated: false,
    });

  } catch (err) {
    logError(reqId, "pipeline", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("RAG error:", message);
    log(reqId, "response_sent", { status: 500, totalMs: Date.now() - tTotal });
    return res.status(500).json({ error: message });
  }
});

// ── /v1/resolve — stable public endpoint (wraps existing RAG pipeline) ────────
// Accepts { text: string }, returns { replyText: string }.
// Does not alter any retrieval, prompt, or handoff logic.

app.post("/v1/resolve", async (req: Request, res: Response) => {
  const reqId  = (req.body?.MessageSid as string | undefined) || genId();
  const tTotal = Date.now();
  const { text } = req.body as { text?: string };

  log(reqId, "request_received", { method: "POST", path: "/v1/resolve" });

  if (!text?.trim()) {
    return res.status(400).json({ error: "Missing or empty 'text' in request body" });
  }

  log(reqId, "input_validated");
  console.log(`[/v1/resolve] ${new Date().toISOString()} len=${text.length}`);

  try {
    log(reqId, "embedding_start");
    const tEmbed = Date.now();
    const embedding = await embedQuestion(text);
    log(reqId, "embedding_done", { durationMs: Date.now() - tEmbed, dims: embedding.length });

    log(reqId, "vector_search_start");
    const tVec = Date.now();
    const chunks = await retrieveChunks(embedding, TOP_K);
    log(reqId, "vector_search_done", { durationMs: Date.now() - tVec, rows: chunks.length });

    log(reqId, "data_checker_start");
    const tChecker = Date.now();
    const checkerResult = await runDataChecker(text, chunks);
    log(reqId, "data_checker_done", { durationMs: Date.now() - tChecker, selected: checkerResult?.relevant_documents?.length ?? 0 });

    if (!checkerResult?.relevant_documents?.length) {
      log(reqId, "response_sent", { status: 200, totalMs: Date.now() - tTotal });
      return res.json({ replyText: NO_ANSWER_MESSAGE });
    }

    const selectedIds = checkerResult.relevant_documents.map((d) => d.id);
    log(reqId, "chunk_fetch_start", { ids: selectedIds.length });
    const tFetch = Date.now();
    const relevantChunks = await fetchChunksByIds(selectedIds);
    log(reqId, "chunk_fetch_done", { durationMs: Date.now() - tFetch, rows: relevantChunks.length });

    if (relevantChunks.length === 0) {
      log(reqId, "response_sent", { status: 200, totalMs: Date.now() - tTotal });
      return res.json({ replyText: NO_ANSWER_MESSAGE });
    }

    log(reqId, "final_answer_start");
    const tFinal = Date.now();
    const finalAnswer = await runRespuestaFinal(text, relevantChunks);
    log(reqId, "final_answer_done", { durationMs: Date.now() - tFinal });

    log(reqId, "response_sent", { status: 200, totalMs: Date.now() - tTotal });
    return res.json({ replyText: finalAnswer.respuesta });

  } catch (err) {
    logError(reqId, "pipeline", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[/v1/resolve] error: ${message}`);
    log(reqId, "response_sent", { status: 500, totalMs: Date.now() - tTotal });
    return res.status(500).json({ error: message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────

async function startup(): Promise<void> {
  await detectDimensions();
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 RAG server running on http://localhost:${PORT}`);
    console.log(`   POST /ask  { "question": "your question here" }`);
    console.log(`   POST /v1/resolve  { "text": "your question here" }`);
    console.log(`   GET  /healthz`);
  });
}

startup().catch((err) => {
  console.error("[startup] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});