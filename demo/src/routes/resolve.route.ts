// ═════════════════════════════════════════════════════════════════════════════
// RESOLVE ROUTE — Handles POST /v1/resolve endpoint
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ROUTE RESPONSIBILITY: Receive HTTP request, call controller, send HTTP response
 *
 * Route: POST /v1/resolve
 * Purpose: Stable public endpoint for RAG with minimal response (answer text only)
 *
 * This is a lightweight wrapper around the RAG pipeline that returns only
 * the final answer text without logic, citations, or source references.
 * Good for simple integrations where you only need the answer.
 *
 * Request body:
 *   {
 *     "text": "What is the document about?",
 *     "MessageSid": "optional Twilio message ID"
 *   }
 *
 * Response (200 OK):
 *   { "replyText": "The answer to your question" }
 *
 * Response (400 Bad Request):
 *   { "error": "Missing or empty 'text' in request body" }
 *
 * Response (500 Internal Server Error):
 *   { "error": "Error message describing what went wrong" }
 */

import { Router, Request, Response } from "express";
import { executeRAGPipelineMinimal } from "../controllers/rag.controller";
import { genId, log, logError } from "../utils/logger";
import { ResolveRequest, ResolveResponse, ErrorResponse } from "../utils/types";

export const resolveRouter = Router();

/**
 * POST /v1/resolve
 *
 * Lightweight endpoint for asking questions against the RAG system.
 * Runs the same RAG pipeline as /ask but returns only the answer text.
 *
 * The controller handles all business logic (same as /ask):
 * - Embedding the text
 * - Vector search for relevant chunks
 * - Data checker stage to select relevant documents
 * - Final answer generation stage
 *
 * This route is responsible for:
 * - Parsing and validating the HTTP request
 * - Calling the controller with the text
 * - Handling errors and returning appropriate HTTP status codes
 * - Formatting the minimal response as JSON
 */
resolveRouter.post("/v1/resolve", async (req: Request, res: Response) => {
  // Generate unique request ID for tracing (or use Twilio MessageSid)
  const reqId  = (req.body?.MessageSid as string | undefined) || genId();
  const tTotal = Date.now();

  const { text } = req.body as ResolveRequest;

  // Log incoming request
  log(reqId, "request_received", { method: "POST", path: "/v1/resolve" });

  // ────────────────────────────────────────────────────────────────────────
  // VALIDATION: Check that text is provided and not empty
  // ────────────────────────────────────────────────────────────────────────
  if (!text?.trim()) {
    log(reqId, "validation_failed", { reason: "missing_text" });
    return res.status(400).json({
      error: "Missing or empty 'text' in request body",
    } as ErrorResponse);
  }

  log(reqId, "input_validated");
  console.log(`[/v1/resolve] ${new Date().toISOString()} len=${text.length}`);

  try {
    // ────────────────────────────────────────────────────────────────────────
    // EXECUTE: Call controller to run the RAG pipeline
    // ────────────────────────────────────────────────────────────────────────
    const result = await executeRAGPipelineMinimal(text, reqId);

    // ────────────────────────────────────────────────────────────────────────
    // RESPOND: Send successful response with only the answer text
    // ────────────────────────────────────────────────────────────────────────
    log(reqId, "response_sent", { status: 200, totalMs: result.executionTime });

    return res.json({
      replyText: result.replyText,
      handoff: result.handoff,
    } as ResolveResponse);

  } catch (err) {
    // ────────────────────────────────────────────────────────────────────────
    // ERROR HANDLING: Log error and send 500 response
    // ────────────────────────────────────────────────────────────────────────
    logError(reqId, "resolve_endpoint", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    const executionTime = Date.now() - tTotal;
    log(reqId, "response_sent", { status: 500, totalMs: executionTime });

    return res.status(500).json({
      error: message,
    } as ErrorResponse);
  }
});
