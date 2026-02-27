// ═════════════════════════════════════════════════════════════════════════════
// RAG PIPELINE SERVICE — Two-stage RAG implementation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Responsibility:
 * - Implement the two-stage RAG pipeline
 * - Stage 1 (data_checker): Select relevant documents using LLM
 * - Stage 2 (respuesta_final): Generate final answer using selected docs
 *
 * This service contains the core RAG logic but uses other services
 * for actual API calls and database operations.
 */

import { buildPrompt, formatChunks } from "./prompt.service";
import { callGemini, parseJSON } from "./gemini.service";
import { fetchChunksByIds } from "./embedding.service";
import {
  Chunk,
  RelevantDocument,
  DataCheckerResponse,
  FinalAnswerResponse,
} from "../utils/types";
import { LANGSMITH_CONFIG, APP_CONFIG } from "../utils/config";

/**
 * STAGE 1: Data Checker
 *
 * Uses an LLM to select the most relevant documents from the retrieved chunks.
 * The LLM receives:
 * - The user's question
 * - The top-K retrieved document chunks
 * - A constraint that it must only select IDs that appear in the documents
 *
 * Returns up to 2 relevant documents with reasons for their selection.
 *
 * SERVICE RESPONSIBILITY: Orchestrate external API calls (prompt building, Gemini)
 *
 * @param question - User's question
 * @param chunks - Top-K chunks retrieved by vector search
 * @returns Data checker response with selected document IDs, or null if no valid response
 */
export async function runDataChecker(
  question: string,
  chunks: Chunk[]
): Promise<DataCheckerResponse | null> {
  // Build the allowed IDs list forced the model to select from existing chunks
  const allowedIds   = chunks.map(c => c.chunk_id).join(", ");
  const idConstraint = `RULE: You MUST only select IDs that appear exactly as DOCUMENT_ID in the documents below. Do NOT invent or modify any ID.\nALLOWED_IDS: ${allowedIds}\n\n`;

  // Fill the data_checker prompt with documents and question
  const filledPrompt = await buildPrompt(LANGSMITH_CONFIG.prompts.dataChecker, {
    question,
    retrieved_document: idConstraint + formatChunks(chunks),
  });

  // Call Gemini to select relevant documents
  const raw     = await callGemini(filledPrompt);
  const cleaned = raw.trim().replace(/```json|```/g, "").trim();

  console.log(`🤖 data_checker raw response:`, cleaned.slice(0, 300));

  // Handle null or empty responses (LLM decided none of the docs are relevant)
  if (cleaned === "null" || cleaned === "") {
    return null;
  }

  try {
    return parseJSON<DataCheckerResponse>(cleaned);
  } catch {
    // If JSON parsing fails, log a warning and return null to trigger fallback
    console.warn("⚠️  data_checker did not return valid JSON:", cleaned.slice(0, 100));
    return null;
  }
}

/**
 * STAGE 2: Respuesta Final (Final Answer)
 *
 * Uses an LLM to generate a comprehensive answer based on the selected documents.
 * The LLM receives:
 * - The user's question
 * - The selected (filtered) document chunks
 * - Client name and context for personalization
 *
 * Returns a structured response with:
 * - respuesta: The final answer to the question
 * - logica: The reasoning behind the answer
 * - docuementacion: Citations/references to the source documents
 *
 * SERVICE RESPONSIBILITY: Orchestrate external API calls (prompt building, Gemini)
 *
 * @param question - User's question
 * @param relevantChunks - Pre-selected chunks from data_checker (after validation)
 * @returns Structured final answer response
 */
export async function runRespuestaFinal(
  question: string,
  relevantChunks: Chunk[]
): Promise<FinalAnswerResponse> {
  // Fill the respuesta_final prompt with the relevant documents
  const filledPrompt = await buildPrompt(LANGSMITH_CONFIG.prompts.respuestaFinal, {
    question,
    retrieved_document: formatChunks(relevantChunks),
    client_name:        APP_CONFIG.clientName,
    mensaje_original:   question,  // Will be replaced with real message when conversation layer is built
    contexto:           "",        // Will be replaced with real context when conversation layer is built
  });

  // Call Gemini to generate the final answer
  const raw = await callGemini(filledPrompt);

  try {
    return parseJSON<FinalAnswerResponse>(raw);
  } catch {
    // If JSON parsing fails, return the raw text as the answer with default handoff false
    console.warn("⚠️  respuesta_final did not return valid JSON:", raw.trim().slice(0, 100));
    return {
      logica:         "Respuesta generada directamente.",
      docuementacion: "",
      respuesta:      raw.trim(),
      handoff:        false, // Default to no escalation if prompt format is broken
    };
  }
}

/**
 * Validates document IDs returned by data_checker against the originally
 * retrieved chunks. Prevents hallucinated IDs from being used.
 *
 * Falls back to top-2 vector results if validation fails.
 *
 * UTILITY FUNCTION: Validate and fallback logic
 *
 * @param checkerResult - Response from data_checker stage
 * @param originalChunks - Original chunks from vector search
 * @returns Validated relevant chunks with audit information
 */
export function validateAndGetRelevantChunks(
  checkerResult: DataCheckerResponse | null,
  originalChunks: Chunk[]
): {
  chunks: Chunk[];
  hadValidation: boolean;
  hadFallback: boolean;
} {
  const validChunkIds = new Set(originalChunks.map(c => c.chunk_id));
  const validatedDocs = (checkerResult?.relevant_documents ?? []).filter(d => validChunkIds.has(d.id));
  const originalCount = checkerResult?.relevant_documents?.length ?? 0;
  const rejectedCount = originalCount - validatedDocs.length;

  if (rejectedCount > 0) {
    console.warn(`⚠️  data_checker hallucinated ${rejectedCount}/${originalCount} IDs — rejected`);
  }

  if (validatedDocs.length > 0) {
    const selectedIds = validatedDocs.map(d => d.id);
    console.log(`✅ data_checker selected IDs (validated):`, selectedIds);
    // Find the validated chunks in the original results
    const selectedChunks = originalChunks.filter(c =>
      validatedDocs.some(d => d.id === c.chunk_id)
    );
    return { chunks: selectedChunks, hadValidation: true, hadFallback: false };
  } else {
    console.warn(`⚠️  No valid IDs from data_checker — falling back to top-2 vector results`);
    return { chunks: originalChunks.slice(0, 2), hadValidation: false, hadFallback: true };
  }
}
