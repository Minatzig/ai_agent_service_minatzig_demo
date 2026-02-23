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
  return response.embeddings![0].values!;
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

app.post("/ask", async (req: Request, res: Response) => {
  const { question } = req.body as { question?: string };

  if (!question?.trim()) {
    return res.status(400).json({ error: "Missing or empty 'question' in request body" });
  }

  try {
    console.log(`\n❓ Question: ${question}`);

    // 1. Embed question
    const embedding = await embedQuestion(question);

    // 2. Retrieve top 5 chunks by vector similarity
    const chunks = await retrieveChunks(embedding, TOP_K);
    console.log(`📚 Retrieved ${chunks.length} chunks:`);
    chunks.forEach((c) =>
      console.log(`   - [${c.chunk_id}] ${c.section_title} (${Number(c.similarity).toFixed(3)})`)
    );

    // 3. Stage 1 — data_checker selects relevant document IDs
    console.log(`\n🔍 Running data_checker...`);
    const checkerResult = await runDataChecker(question, chunks);

    // 4. Escalate if no relevant documents found
    if (!checkerResult?.relevant_documents?.length) {
      console.log(`⚠️  No relevant documents — escalating to human`);
      return res.json({
        answer:    NO_ANSWER_MESSAGE,
        sources:   [],
        escalated: true,
      });
    }

    const selectedIds = checkerResult.relevant_documents.map((d) => d.id);
    console.log(`✅ data_checker selected IDs:`, selectedIds);

    // 5. Fetch selected chunks directly from DB by ID
    const relevantChunks = await fetchChunksByIds(selectedIds);

    if (relevantChunks.length === 0) {
      console.warn(`⚠️  No chunks found in DB for selected IDs — escalating to human`);
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
    const finalAnswer = await runRespuestaFinal(question, relevantChunks);
    console.log(`✅ Answer generated`);

    // 7. Return structured response
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
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("RAG error:", message);
    return res.status(500).json({ error: message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`🚀 RAG server running on http://localhost:${PORT}`);
  console.log(`   POST /ask  { "question": "your question here" }`);
});