// ═════════════════════════════════════════════════════════════════════════════
// RAG CONTROLLER — Orchestrates the RAG pipeline business logic
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Responsibility:
 * - Orchestrate the complete RAG pipeline from question to answer
 * - Call services in the correct order
 * - Handle fallbacks and error scenarios
 * - Validate inputs and outputs
 * - Format responses for the API
 *
 * This layer contains the business logic but delegates to services for:
 * - Database operations
 * - External API calls
 * - Prompt building
 *
 * Controllers should be independent of Express - they just take inputs
 * and return outputs. Routes will call controllers and handle HTTP.
 */

import {
  embedQuestion,
  retrieveChunks,
  fetchChunksByIds,
  detectDimensions,
} from "../services/embedding.service";
import {
  runDataChecker,
  runRespuestaFinal,
  validateAndGetRelevantChunks,
} from "../services/rag-pipeline.service";
import {
  AskResponse,
  ResolveResponse,
  SourceReference,
  Chunk,
} from "../utils/types";
import { log, logError } from "../utils/logger";
import { RAG_CONFIG } from "../utils/config";

/**
 * RAG Pipeline Controller
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Executes the complete RAG (Retrieval-Augmented Generation) pipeline:
 *
 * 1. EMBEDDING: Convert question to vector embedding
 * 2. RETRIEVAL: Find top-K similar documents using vector search
 * 3. DATA_CHECKER: Use LLM to select most relevant documents
 * 4. VALIDATION: Ensure selected IDs are real (prevent hallucinations)
 * 5. FINAL_ANSWER: Use LLM to generate answer from selected docs
 * 6. FORMATTING: Prepare response with sources
 *
 * CONTROLLER RESPONSIBILITY: Coordinate services and implement business logic
 */
export async function executeRAGPipeline(
  question: string,
  reqId: string
): Promise<{
  answer: string;
  logic: string;
  sources: SourceReference[];
  handoff: boolean;
  executionTime: number;
}> {
  const tTotal = Date.now();

  try {
    // ────────────────────────────────────────────────────────────────────────
    // STEP 1: Embed the question using Gemini
    // ────────────────────────────────────────────────────────────────────────
    console.log(`\n❓ Question: ${question}`);
    log(reqId, "embedding_start");
    const tEmbed = Date.now();
    const embedding = await embedQuestion(question);
    log(reqId, "embedding_done", { durationMs: Date.now() - tEmbed, dims: embedding.length });

    // ────────────────────────────────────────────────────────────────────────
    // STEP 2: Retrieve top-K chunks using vector similarity
    // ────────────────────────────────────────────────────────────────────────
    log(reqId, "vector_search_start");
    const tVec = Date.now();
    const chunks = await retrieveChunks(embedding, RAG_CONFIG.topK);
    log(reqId, "vector_search_done", { durationMs: Date.now() - tVec, rows: chunks.length });

    console.log(`📚 Retrieved ${chunks.length} chunks:`);
    chunks.forEach((c) =>
      console.log(`   - [${c.chunk_id}] ${c.section_title} (${Number(c.similarity).toFixed(3)})`)
    );

    // ────────────────────────────────────────────────────────────────────────
    // STEP 3: Run data_checker to select relevant documents
    // ────────────────────────────────────────────────────────────────────────
    console.log(`\n🔍 Running data_checker...`);
    log(reqId, "data_checker_start");
    const tChecker = Date.now();
    const checkerResult = await runDataChecker(question, chunks);
    log(reqId, "data_checker_done", {
      durationMs: Date.now() - tChecker,
      selected: checkerResult?.relevant_documents?.length ?? 0,
    });

    // ────────────────────────────────────────────────────────────────────────
    // STEP 4: Validate data_checker IDs and handle fallback
    // ────────────────────────────────────────────────────────────────────────
    const { chunks: relevantChunks, hadFallback } = validateAndGetRelevantChunks(
      checkerResult,
      chunks
    );

    console.log(`📄 Passing to respuesta_final:`);
    relevantChunks.forEach((c) =>
      console.log(`   - [${c.chunk_id}] ${c.section_title}`)
    );

    // ────────────────────────────────────────────────────────────────────────
    // STEP 5: Run respuesta_final to generate answer
    // ────────────────────────────────────────────────────────────────────────
    console.log(`\n💬 Running respuesta_final...`);
    log(reqId, "final_answer_start");
    const tFinal = Date.now();
    const finalAnswer = await runRespuestaFinal(question, relevantChunks);
    log(reqId, "final_answer_done", { durationMs: Date.now() - tFinal });
    console.log(`✅ Answer generated`);

    // ────────────────────────────────────────────────────────────────────────
    // STEP 6: Format response with source references
    // ────────────────────────────────────────────────────────────────────────
    const sources: SourceReference[] = relevantChunks.map((c) => ({
      chunk_id:      c.chunk_id,
      section_title: c.section_title,
      source_file:   c.source_file,
    }));

    const executionTime = Date.now() - tTotal;
    log(reqId, "response_prepared", { status: 200, totalMs: executionTime });

    return {
      answer: finalAnswer.respuesta,
      logic: finalAnswer.logica,
      sources,
      handoff: finalAnswer.handoff,
      executionTime,
    };
  } catch (err) {
    const executionTime = Date.now() - tTotal;
    logError(reqId, "rag_pipeline", err);
    throw err; // Re-throw to be handled by route
  }
}

/**
 * Lightweight RAG Pipeline for /v1/resolve endpoint
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Same RAG pipeline as above, but returns only the answer text
 * (no logic, citations, or sources for minimal response).
 *
 * CONTROLLER RESPONSIBILITY: Coordinate services for simplified response
 */
export async function executeRAGPipelineMinimal(
  text: string,
  reqId: string
): Promise<{
  replyText: string;
  handoff: boolean;
  executionTime: number;
}> {
  const tTotal = Date.now();

  try {
    // Run the same pipeline as the full version
    console.log(`[/v1/resolve] Text: ${text}`);

    // Step 1: Embed
    log(reqId, "embedding_start");
    const tEmbed = Date.now();
    const embedding = await embedQuestion(text);
    log(reqId, "embedding_done", { durationMs: Date.now() - tEmbed });

    // Step 2: Retrieve
    log(reqId, "vector_search_start");
    const tVec = Date.now();
    const chunks = await retrieveChunks(embedding, RAG_CONFIG.topK);
    log(reqId, "vector_search_done", { durationMs: Date.now() - tVec, rows: chunks.length });

    // Step 3: Data checker
    log(reqId, "data_checker_start");
    const tChecker = Date.now();
    const checkerResult = await runDataChecker(text, chunks);
    log(reqId, "data_checker_done", {
      durationMs: Date.now() - tChecker,
      selected: checkerResult?.relevant_documents?.length ?? 0,
    });

    // Step 4: Validate and fallback
    const { chunks: relevantChunks } = validateAndGetRelevantChunks(
      checkerResult,
      chunks
    );

    // Step 5: Generate answer
    log(reqId, "final_answer_start");
    const tFinal = Date.now();
    const finalAnswer = await runRespuestaFinal(text, relevantChunks);
    log(reqId, "final_answer_done", { durationMs: Date.now() - tFinal });

    const executionTime = Date.now() - tTotal;
    log(reqId, "response_prepared", { status: 200, totalMs: executionTime });

    return {
      replyText: finalAnswer.respuesta,
      handoff: finalAnswer.handoff, // Include handoff flag from LangSmith prompt
      executionTime,
    };
  } catch (err) {
    const executionTime = Date.now() - tTotal;
    logError(reqId, "rag_pipeline_minimal", err);
    throw err; // Re-throw to be handled by route
  }
}
