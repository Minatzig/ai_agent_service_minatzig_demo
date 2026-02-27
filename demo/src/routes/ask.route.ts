// ═════════════════════════════════════════════════════════════════════════════
// ASK ROUTE — Handles POST /ask endpoint
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ROUTE RESPONSIBILITY: Receive HTTP request, call controller, send HTTP response
 *
 * Route: POST /ask
 * Purpose: Full RAG pipeline with structured response including logic, citations, and sources
 *
 * Request body:
 *   {
 *     "question": "What is the document about?",
 *     "MessageSid": "optional Twilio message ID"
 *   }
 *
 * Response (200 OK):
 *   {
 *     "answer": "The answer to your question",
 *     "logic": "The reasoning behind the answer",
 *     "citation": "Reference to source documents",
 *     "sources": [
 *       { "chunk_id": "...", "section_title": "...", "source_file": "..." }
 *     ],
 *     "escalated": false
 *   }
 *
 * Response (400 Bad Request):
 *   { "error": "Missing or empty 'question' in request body" }
 *
 * Response (500 Internal Server Error):
 *   { "error": "Error message describing what went wrong" }
 */

import { Router, Request, Response } from "express";
import { executeRAGPipeline } from "../controllers/rag.controller";
import { genId, log, logError } from "../utils/logger";
import { AskRequest, AskResponse, ErrorResponse } from "../utils/types";

export const askRouter = Router();

/**
 * POST /ask
 *
 * Endpoint for asking questions against the RAG system.
 * Returns the full structured response with answer, logic, citations, and sources.
 *
 * The controller handles all business logic:
 * - Embedding the question
 * - Vector search for relevant chunks
 * - Data checker stage to select relevant documents
 * - Final answer generation stage
 *
 * This route is responsible for:
 * - Parsing and validating the HTTP request
 * - Calling the controller with the question
 * - Handling errors and returning appropriate HTTP status codes
 * - Formatting the response as JSON
 */
askRouter.post("/ask", async (req: Request, res: Response) => {
  // Generate unique request ID for tracing (or use Twilio MessageSid)
  const reqId  = (req.body?.MessageSid as string | undefined) || genId();
  const tTotal = Date.now();

  const { question } = req.body as AskRequest;

  // Log incoming request
  log(reqId, "request_received", { method: "POST", path: "/ask" });

  // ────────────────────────────────────────────────────────────────────────
  // VALIDATION: Check that question is provided and not empty
  // ────────────────────────────────────────────────────────────────────────
  if (!question?.trim()) {
    log(reqId, "validation_failed", { reason: "missing_question" });
    return res.status(400).json({
      error: "Missing or empty 'question' in request body",
    } as ErrorResponse);
  }

  log(reqId, "input_validated");

  try {
    // ────────────────────────────────────────────────────────────────────────
    // EXECUTE: Call controller to run the RAG pipeline
    // ────────────────────────────────────────────────────────────────────────
    const result = await executeRAGPipeline(question, reqId);

    // ────────────────────────────────────────────────────────────────────────
    // RESPOND: Send successful response with all pipeline outputs
    // ────────────────────────────────────────────────────────────────────────
    log(reqId, "response_sent", { status: 200, totalMs: result.executionTime });

    return res.json({
      answer: result.answer,
      logic: result.logic,
      sources: result.sources,
      handoff: result.handoff,
    } as AskResponse);

  } catch (err) {
    // ────────────────────────────────────────────────────────────────────────
    // ERROR HANDLING: Log error and send 500 response
    // ────────────────────────────────────────────────────────────────────────
    logError(reqId, "ask_endpoint", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    const executionTime = Date.now() - tTotal;
    log(reqId, "response_sent", { status: 500, totalMs: executionTime });

    return res.status(500).json({
      error: message,
    } as ErrorResponse);
  }
});
