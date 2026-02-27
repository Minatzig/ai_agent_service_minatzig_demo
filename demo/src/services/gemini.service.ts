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

// ── Initialize Gemini Client (wrapped for LangSmith tracing) ────────────────────
const geminiClient = new GoogleGenAI({ apiKey: GEMINI_CONFIG.apiKey! });
const gemini = wrapGemini(geminiClient);

/**
 * Calls the Gemini API to generate content from a given prompt.
 * Uses the gemini-2.5-flash model for fast content generation.
 *
 * SERVICE RESPONSIBILITY: External API call to generate content
 *
 * @param prompt - The prompt to send to Gemini
 * @returns The generated text response from Gemini
 */
export async function callGemini(prompt: string): Promise<string> {
  const response = await gemini.models.generateContent({
    model: GEMINI_CONFIG.generationModel,
    contents: prompt,
  });
  return response.text ?? "";
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
