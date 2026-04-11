// ═════════════════════════════════════════════════════════════════════════════
// PROMPT SERVICE — Fetch and build prompts from LangSmith
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Responsibility:
 * - Pull prompts from LangSmith hub
 * - Fill prompt templates with variables
 * - Extract and format messages properly
 *
 * This service abstracts the complexity of LangSmith prompt management.
 * Controllers call these functions to get formatted prompts before sending to Gemini.
 */

import { LANGSMITH_CONFIG } from "../utils/config";
import { Chunk } from "../utils/types";

// Use require for langchain/hub/node to avoid TypeScript module resolution issues
// @ts-ignore - langchain/hub has known TypeScript issues in some environments
const hubImport = require("langchain/hub/node");

/**
 * Formats document chunks into a structured XML string for prompt injection.
 * Each chunk is enclosed with XML tags for clear document separation.
 *
 * UTILITY FUNCTION: Formats data for injecting into prompts
 *
 * @param chunks - Array of document chunks to format
 * @returns An XML formatted string representation of all chunks
 */
export function formatChunks(chunks: Chunk[]): string {
  return chunks.map((c) =>
    `<document>
  <document_id>${c.chunk_id}</document_id>
  <source>${c.source_file} > ${c.section_title}</source>
  <content>
${c.text}
  </content>
</document>`
  ).join("\n\n");
}

/**
 * Pulls a prompt template from LangSmith and fills it with the provided variables.
 *
 * IMPORTANT: LangSmith prompts are ChatPromptTemplates with SYSTEM + HUMAN messages.
 * We extract each message individually to ensure all content (especially system
 * prompts containing the documents) is included. Otherwise, only the HUMAN message
 * gets sent to Gemini.
 *
 * SERVICE RESPONSIBILITY: External API call to fetch and process prompt templates
 *
 * @param promptName - Name and version of the prompt in LangSmith (e.g., "data_checker:885899c9")
 * @param vars - Variables to fill into the template
 * @returns Formatted prompt string ready to send to Gemini
 */
export async function buildPrompt(
  promptName: string,
  vars: Record<string, string>
): Promise<string> {
  // Fetch the prompt template from LangSmith hub
  const prompt = await hubImport.pull(promptName, {
    apiKey: LANGSMITH_CONFIG.apiKey,
    apiUrl: LANGSMITH_CONFIG.apiUrl,
  });

  console.log(`\n📋 [DEBUG] Prompt template: ${promptName}`);
  console.log(`📋 [DEBUG] Variables being passed:`, Object.keys(vars));
  for (const [k, v] of Object.entries(vars)) {
    console.log(`  - ${k}: ${v.substring(0, 100)}...`);
  }

  // Fill the template with provided variables
  const promptValue = await (prompt as any).invoke(vars);

  console.log(`📋 [DEBUG] After invoke() - promptValue type:`, typeof promptValue);
  console.log(`📋 [DEBUG] promptValue keys:`, Object.keys(promptValue || {}));

  // Extract all messages from the ChatPromptValue
  // This is critical because ChatPromptTemplates have both SYSTEM and HUMAN messages
  const messages = promptValue.messages || promptValue.toChatMessages?.() || [];

  console.log(`📋 [DEBUG] Extracted ${messages.length} messages from promptValue`);

  if (messages.length > 0) {
    // Build the final prompt by concatenating all message types
    let filled = messages
      .map((m: any) => {
        const role    = m._getType?.() || m.role || "human";
        const content = m.content || "";
        return `${role.toUpperCase()}: ${content}`;
      })
      .join("\n\n");

    // Manually interpolate variables if LangChain didn't do it
    for (const [key, value] of Object.entries(vars)) {
      const placeholder = `{${key}}`;
      if (filled.includes(placeholder)) {
        console.log(`🔄 [DEBUG] Manually interpolating ${placeholder} with ${String(value).substring(0, 50)}...`);
        filled = filled.replaceAll(placeholder, String(value));
      }
    }

    console.log(`📝 Prompt "${promptName}" filled:\n`, filled);
    return filled;
  }

  // Fallback if no messages found (shouldn't happen normally)
  let filled = promptValue.toString();
  
  // Manually interpolate variables
  for (const [key, value] of Object.entries(vars)) {
    const placeholder = `{${key}}`;
    if (filled.includes(placeholder)) {
      console.log(`🔄 [DEBUG] Manually interpolating ${placeholder} (fallback)`);
      filled = filled.replaceAll(placeholder, String(value));
    }
  }
  
  console.log(`📝 Prompt "${promptName}" filled (fallback):\n`, filled);
  return filled;
}
