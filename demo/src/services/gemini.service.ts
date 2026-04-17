// ═════════════════════════════════════════════════════════════════════════════
// GEMINI SERVICE — Call Gemini API for content generation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Responsibility:
 * - Call Gemini API with prompts
 * - Parse JSON responses
 * - Handle response errors gracefully
 *
 * This service encapsulates all interactions with the Gemini API.
 * Controllers call these functions to generate content.
 */

import { GoogleGenAI } from "@google/genai";
import { wrapGemini } from "langsmith/wrappers/gemini";
import { GEMINI_CONFIG } from "../utils/config";
import { withRetry, withTimeout } from "../utils/async";

// ── Initialize Gemini Client (wrapped for LangSmith tracing) ────────────────────
const geminiClient = new GoogleGenAI({ apiKey: GEMINI_CONFIG.apiKey! });
const gemini = wrapGemini(geminiClient);

const GEMINI_GENERATE_TIMEOUT_MS = 30_000;
const GEMINI_GENERATE_RETRIES    = 1;
const GEMINI_GENERATE_RETRY_MS   = 1_000;

/**
 * Calls the Gemini API to generate content from a given prompt.
 * Wrapped with a 30s timeout and 1 retry (1s delay) on failure.
 *
 * @param prompt - The prompt to send to Gemini
 * @param ctx    - Optional reqId / stage for retry logging
 * @returns The generated text response from Gemini
 */
export async function callGemini(
  prompt: string,
  ctx?: { reqId?: string; stage?: string }
): Promise<string> {
  const stage = ctx?.stage ?? "gemini_generate";
  return withRetry(
    () =>
      withTimeout(
        (async () => {
          const response = await gemini.models.generateContent({
            model: GEMINI_CONFIG.generationModel,
            contents: prompt,
          });
          return response.text ?? "";
        })(),
        GEMINI_GENERATE_TIMEOUT_MS,
        `gemini_generate(${stage})`
      ),
    {
      retries: GEMINI_GENERATE_RETRIES,
      delayMs: GEMINI_GENERATE_RETRY_MS,
      stage,
      reqId: ctx?.reqId,
    }
  );
}

/**
 * Parses a JSON string response, handling Markdown code blocks.
 * Removes ```json and ``` markers that sometimes appear in model output.
 *
 * UTILITY FUNCTION: Parse and validate structured responses
 *
 * @param raw - Raw response string from Gemini
 * @returns Parsed JSON object of type T
 * @throws Error if the JSON is invalid
 */
export function parseJSON<T>(raw: string): T {
  const cleaned = raw.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned) as T;
}
