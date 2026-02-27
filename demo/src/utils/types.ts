// ═════════════════════════════════════════════════════════════════════════════
// TYPES — Shared type definitions used across routes, controllers, and services
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Represents a document chunk retrieved from the database.
 * Contains text content, metadata, and similarity score.
 */
export interface Chunk {
  chunk_id:      string;
  source_file:   string;
  section_title: string;
  text:          string;
  similarity:    number;
}

/**
 * Represents a document selected by the data_checker stage.
 * Contains the document ID and the reason it was selected.
 */
export interface RelevantDocument {
  id:     string;
  reason: string;
}

/**
 * Response from the data_checker LangSmith prompt.
 * Selects up to 2 relevant documents from the retrieved chunks.
 */
export interface DataCheckerResponse {
  relevant_documents: RelevantDocument[];
}

/**
 * Response from the respuesta_final LangSmith prompt.
 * Contains the final answer, logic explanation, documentation reference, and escalation info.
 */
export interface FinalAnswerResponse {
  logica:         string;
  docuementacion: string; // matches typo in LangSmith prompt intentionally
  respuesta:      string;
  handoff:        boolean; // Whether the query should be escalated to a human
}

/**
 * Request body for the /ask endpoint.
 * Contains the user's question.
 */
export interface AskRequest {
  question?: string;
  MessageSid?: string; // Optional Twilio message ID
}

/**
 * Response from the /ask endpoint.
 * Contains the final answer, sources, and metadata.
 */
export interface AskResponse {
  answer:    string;
  logic:     string;
  sources:   SourceReference[];
  handoff:   boolean; // Whether the query should be escalated to a human
}

/**
 * Request body for the /v1/resolve endpoint.
 * Contains the user's text input.
 */
export interface ResolveRequest {
  text?: string;
  MessageSid?: string; // Optional Twilio message ID
}

/**
 * Response from the /v1/resolve endpoint.
 * Contains only the reply text (minimal response).
 */
export interface ResolveResponse {
  replyText: string;
  handoff:   boolean; // Whether the query should be escalated to a human
}

/**
 * Error response for all endpoints.
 */
export interface ErrorResponse {
  error: string;
}

/**
 * Reference to a source document used in the answer.
 */
export interface SourceReference {
  chunk_id:      string;
  section_title: string;
  source_file:   string;
}

/**
 * Request context tracked throughout the RAG pipeline.
 * Used for logging and tracing requests end-to-end.
 */
export interface RequestContext {
  reqId:  string;
  startTime: number;
}
