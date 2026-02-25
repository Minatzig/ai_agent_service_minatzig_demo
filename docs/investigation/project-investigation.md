# Project Investigation: agent_natzig

**Date:** 2026-02-24
**Investigator:** Technical investigation — read-only, no modifications made

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Architecture Analysis](#2-architecture-analysis)
3. [Environment Variables](#3-environment-variables)
4. [Database Layer](#4-database-layer)
5. [AI Integration](#5-ai-integration)
6. [Code Quality Assessment](#6-code-quality-assessment)
7. [Production Readiness Assessment](#7-production-readiness-assessment)
8. [Integration Feasibility](#8-integration-feasibility)

---

## 1. High-Level Overview

### Purpose

This project is a **RAG (Retrieval-Augmented Generation) proof-of-concept** for a client-facing Q&A assistant. It allows a user to submit a natural language question, retrieves relevant documentation chunks from a vector database, and generates a structured answer using an LLM. If no relevant documents are found, it escalates the question to a human operator.

The client name (`"Vicky"`) is hardcoded directly in `demo/rag.ts:23`, indicating this is a customer-specific deployment for a named client.

### Components

The repository contains **three distinct, loosely related layers**:

| Component | Location | Type | Language |
|---|---|---|---|
| RAG HTTP server | `demo/rag.ts` | Express.js API | TypeScript |
| Data ingestion pipeline | `chunking_documentation/` | Offline scripts | Python |
| Exploratory prototypes | `main.py`, `debug.py` | Standalone scripts | Python |

These are **not integrated** — they are separate runnable units. There is no shared configuration, no shared process, and no package linking between them.

### Entry Point

- **Server:** `demo/rag.ts` — executed with `npx ts-node rag.ts` (no `start` script defined in `package.json`)
- **Data pipeline:** Run manually in order:
  1. `chunking_documentation/markdown_converter.py` — converts PDF/DOCX to Markdown
  2. `chunking_documentation/chunker.py` — splits and enriches chunks using Gemini LLM
  3. `chunking_documentation/embed_and_insert.py` — embeds chunks and inserts into PostgreSQL
- **Prototypes:** `main.py` and `debug.py` are standalone scripts, unrelated to the server

### Runtime

- **Server runtime:** Node.js with TypeScript (compiled via `ts-node`). Target: `ES2021` (`demo/tsconfig.json:4`)
- **Python scripts:** Python 3 (version not pinned; no `pyproject.toml`, `requirements.txt`, or `Pipfile`)
- **Framework:** Express 5.x (`"express": "^5.2.1"` in `demo/package.json:17`)
- **Database:** PostgreSQL with the `pgvector` extension
- **ORM:** Drizzle ORM (`"drizzle-orm": "^0.45.1"`)

---

## 2. Architecture Analysis

### Folder Structure

```
agent_natzig/
├── README.md                          # Minimal — just the project name
├── .gitignore                         # Python + Node combined gitignore
├── main.py                            # Prototype: LangGraph + OpenRouter (unrelated to demo)
├── debug.py                           # Utility: API key validator/debugger
│
├── chunking_documentation/            # Offline data ingestion pipeline (Python)
│   ├── markdown_converter.py          # Stage 0: PDF/DOCX → Markdown
│   ├── chunker.py                     # Stage 1: Markdown → enriched JSON chunks (via Gemini LLM)
│   └── embed_and_insert.py            # Stage 2: JSON chunks → embeddings → PostgreSQL
│
└── demo/                              # Live RAG server (TypeScript/Node)
    ├── .env                           # ⚠️ Contains real credentials — committed to git
    ├── package.json                   # Node dependencies
    ├── tsconfig.json                  # TypeScript config
    ├── migrate.ts                     # One-time DB migration script (run manually)
    ├── schema.ts                      # Drizzle ORM table definition
    └── rag.ts                         # Main Express server — the entire application
```

### Responsibilities Per Module

| File | Responsibility |
|---|---|
| `demo/rag.ts` | **Entire server logic** — HTTP routing, embedding, vector search, two-stage LLM pipeline, response formatting |
| `demo/schema.ts` | Drizzle ORM schema definition for `document_chunks` table |
| `demo/migrate.ts` | One-time migration: enables pgvector, creates table, creates HNSW index |
| `chunking_documentation/markdown_converter.py` | Converts PDF/DOCX source documents to Markdown |
| `chunking_documentation/chunker.py` | Uses Gemini LLM to split Markdown into logical chunks; enriches with context if needed |
| `chunking_documentation/embed_and_insert.py` | Generates Gemini embeddings for each chunk; inserts into PostgreSQL |
| `main.py` | **Prototype only** — LangGraph chatbot using OpenRouter (different model/stack, not connected to the RAG server) |
| `debug.py` | **Utility only** — validates `OPENROUTER_API_KEY` and tests a basic API call |

### Flow of Execution (Server — `demo/rag.ts`)

```
Client (POST /ask)
    │
    ▼
Express middleware (express.json())
    │
    ▼
Route handler — validate "question" field present and non-empty
    │
    ▼
embedQuestion()
    └── Gemini API: gemini-embedding-001 → number[] (768-dim vector)
    │
    ▼
retrieveChunks()
    └── PostgreSQL: cosine distance vector search via pgvector
        SELECT ... FROM document_chunks ORDER BY embedding <=> $vector LIMIT 5
    │
    ▼
runDataChecker() — Stage 1 LLM call
    └── hub.pull("data_checker:885899c9") from LangSmith (network call)
    └── Gemini API: gemini-2.5-flash → JSON { relevant_documents: [{id, reason}] }
    │
    ├── If no relevant docs → return escalated response (human handoff)
    │
    ▼
fetchChunksByIds()
    └── PostgreSQL: SELECT ... WHERE chunk_id = ANY(...)
    │
    ▼
runRespuestaFinal() — Stage 2 LLM call
    └── hub.pull("respuesta_final:fca2401d") from LangSmith (network call)
    └── Gemini API: gemini-2.5-flash → JSON { logica, docuementacion, respuesta }
    │
    ▼
Return structured JSON response to client
    { answer, logic, citation, sources, escalated: false }
```

### Where AI Is Invoked

All AI calls go through `@google/genai` SDK, wrapped with `wrapGemini()` from `langsmith/wrappers/gemini`:

- `embedQuestion()` → `demo/rag.ts:83-89` — embedding model
- `runDataChecker()` → `demo/rag.ts:199-223` — relevance filtering LLM call
- `runRespuestaFinal()` → `demo/rag.ts:227-251` — final answer generation LLM call
- `buildPrompt()` → `demo/rag.ts:149-180` — fetches prompts from LangSmith Hub on every request

### Where DB Access Occurs

- `retrieveChunks()` → `demo/rag.ts:93-109` — raw SQL via Drizzle `db.execute(sql\`...\`)`
- `fetchChunksByIds()` → `demo/rag.ts:113-130` — raw SQL via Drizzle `db.execute(sql\`...\`)`
- Both queries bypass Drizzle's query builder in favor of raw SQL template literals

### Architecture Diagram

```
Client (HTTP)
    │
    │ POST /ask { question: string }
    ▼
┌─────────────────────────────────────┐
│   Express Server (demo/rag.ts)      │
│   Port: 3000 (configurable via ENV) │
└──────────┬──────────────────────────┘
           │
    ┌──────▼──────┐
    │  PostgreSQL  │  (pgvector extension)
    │  document_   │  HNSW index on embedding column
    │  chunks table│  Cosine similarity search (TOP_K=5)
    └──────┬───────┘
           │
    ┌──────▼──────┐
    │  LangSmith   │  Prompt Hub (data_checker, respuesta_final)
    │  (EU region) │  Also receives traces via wrapGemini
    └──────┬───────┘
           │
    ┌──────▼──────┐
    │  Google     │
    │  Gemini API │  gemini-embedding-001 (embeddings)
    │             │  gemini-2.5-flash (LLM inference)
    └──────┬───────┘
           │
    ┌──────▼──────┐
    │  Response   │
    │  to Client  │  { answer, logic, citation, sources, escalated }
    └─────────────┘
```

---

## 3. Environment Variables

### Variables Defined in `demo/.env`

> **CRITICAL SECURITY ISSUE:** The `.env` file is committed to the git repository. All values below are live credentials exposed in version control. See [Code Quality Assessment](#6-code-quality-assessment) for full details.

| Variable | Value in Repo | Required | Notes |
|---|---|---|---|
| `DB_HOST` | `localhost` | No | Defaults to `localhost` in code (`demo/rag.ts:43`) |
| `DB_PORT` | `5432` | No | Defaults to `5432` in code (`demo/rag.ts:44`) |
| `DB_NAME` | `demo_documentation` | **Yes** | Validated at startup (`demo/rag.ts:32`) |
| `DB_USER` | `mi_natzing_demo` | **Yes** | Validated at startup |
| `DB_PASSWORD` | `DemoPoc123` | **Yes** | Validated at startup; **plaintext in committed file** |
| `GEMINI_API_KEY` | `AIzaSyDvP...` (real key) | **Yes** | Validated at startup; **exposed in committed .env AND hardcoded in `chunker.py:9`** |
| `LANGSMITH_TRACING` | `true` | No | Controls LangSmith tracing (boolean string) |
| `LANGSMITH_API_KEY` | `lsv2_pt_3d03b...` (real key) | **Yes** | Validated at startup; **exposed in committed .env** |
| `LANGSMITH_PROJECT` | `MiNatzig` | No | Project label in LangSmith dashboard |
| `LANGSMITH_ENDPOINT` | `https://eu.api.smith.langchain.com` | No | Hardcoded redundantly in `rag.ts:28` as `LANGSMITH_API_URL` |
| `PORT` | `3000` | No | Server port; defaults to `3000` if absent (`demo/rag.ts:339`) |

### Variables Used by Python Scripts (Not Centrally Declared)

| Variable | Used In | Required | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | `embed_and_insert.py:20` | **Yes** | Loaded via `dotenv`; but hardcoded directly in `chunker.py:9` |
| `DB_HOST` | `embed_and_insert.py:37` | **Yes** | |
| `DB_PORT` | `embed_and_insert.py:38` | **Yes** | |
| `DB_NAME` | `embed_and_insert.py:39` | **Yes** | |
| `DB_USER` | `embed_and_insert.py:40` | **Yes** | |
| `DB_PASSWORD` | `embed_and_insert.py:41` | **Yes** | |

### Hardcoded Constants (Should Be Env Vars)

- `CLIENT_NAME = "Vicky"` — `demo/rag.ts:23` — hardcoded client name injected into final prompt
- `PROMPT_DATA_CHECKER = "data_checker:885899c9"` — `demo/rag.ts:24` — pinned LangSmith commit hash
- `PROMPT_RESPUESTA_FINAL = "respuesta_final:fca2401d"` — `demo/rag.ts:25` — pinned LangSmith commit hash
- `TOP_K = 5` — `demo/rag.ts:26` — number of retrieved chunks
- `NO_ANSWER_MESSAGE = "Esta pregunta debe ser contestada por un humano."` — `demo/rag.ts:27` — hardcoded in Spanish
- `LANGSMITH_API_URL = "https://eu.api.smith.langchain.com"` — `demo/rag.ts:28` — duplicates the env var
- `GEMINI_API_KEY = "AIzaSyD..."` — `chunking_documentation/chunker.py:9` — hardcoded directly in source

### Environment Suffixing

No `DEV`/`PROD` suffixing is used. There is a single `.env` file with no environment-specific overrides.

---

## 4. Database Layer

### Database Used

- **PostgreSQL** with the **pgvector** extension
- Extension: `CREATE EXTENSION IF NOT EXISTS vector` — `demo/migrate.ts:25`
- Index type: **HNSW** (Hierarchical Navigable Small World) for approximate nearest-neighbor search — `demo/migrate.ts:45-49`

### Table Schema

One table: `document_chunks`

| Column | Type | Constraint | Description |
|---|---|---|---|
| `chunk_id` | TEXT | PRIMARY KEY | UUID generated by `chunker.py` |
| `source_file` | TEXT | NOT NULL | Original filename |
| `doc_type` | TEXT | nullable | e.g., `faq`, `manual`, `error_guide` |
| `section_title` | TEXT | nullable | LLM-assigned section title |
| `chunk_index` | INTEGER | nullable | Position within source document |
| `self_contained` | BOOLEAN | nullable | Whether chunk needs context injection |
| `missing_context` | TEXT | nullable | Description of missing context |
| `summary` | TEXT | nullable | One-sentence summary for embedding |
| `text` | TEXT | NOT NULL | Full chunk text (possibly enriched) |
| `embed_input` | TEXT | nullable | Combined summary + text used for embedding |
| `embedding` | vector | nullable | Floating-point vector |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

### Schema Mismatch — Critical Bug

- `demo/migrate.ts:40`: creates column as `vector(768)` — matches `gemini-embedding-001` actual output
- `demo/schema.ts:8`: defines custom type returning `vector(3072)` in the Drizzle schema
- The schema TypeScript definition is **incorrect** relative to the migration SQL and the actual model dimensions. Drizzle's schema is not used for the live queries (both queries use raw `db.execute(sql\`...\`)` instead of the schema), so the mismatch does not cause a runtime error — but it means the schema file cannot be used to generate accurate migrations.

### Connection Handling

- A single `pg.Pool` is created at module load — `demo/rag.ts:41-47`
- No explicit pool configuration: no `max` (connections), no `idleTimeoutMillis`, no `connectionTimeoutMillis`
- `pg` default: `max = 10` connections
- No connection event error handling on the pool itself
- Same pattern in `demo/migrate.ts:12-19` with explicit `pool.end()` after migration

### Query Layer vs Business Logic Separation

- **None.** All database queries are co-located in `demo/rag.ts` alongside HTTP routing, LLM calls, and response formatting
- `retrieveChunks()` and `fetchChunksByIds()` are functions within the same file as the Express route handler
- There is no repository pattern, no data access layer, no service layer

### SQL Injection Risk

- Both queries use Drizzle's `sql` template tag for parameterization
- `retrieveChunks()` — `demo/rag.ts:94-108`: The vector string is constructed via `embedding.join(",")` and injected as `${vectorStr}::vector`. Drizzle's `sql` tag passes this as a parameter, not raw string concatenation, which is safe
- `fetchChunksByIds()` — `demo/rag.ts:116-129`: Uses `sql.join()` with individual `sql\`${id}\`` fragments. The `id` values come from the LLM response (`checkerResult.relevant_documents`), not directly from user input. However, LLM output is not sanitized before being used as query parameters. This is a low-severity risk since LLM output is controlled, but worth noting
- **No direct SQL injection risk** from user-supplied `question` — the question is only used as an embedding input, never interpolated into SQL

---

## 5. AI Integration

### Provider

**Google Gemini** exclusively, via `@google/genai` SDK (`"@google/genai": "^1.42.0"`)

- Embedding model: `gemini-embedding-001` (768 dimensions based on migration SQL; schema.ts incorrectly states 3072)
- LLM model: `gemini-2.5-flash`

The `main.py` prototype uses **OpenRouter** (with `langchain_openai.ChatOpenAI` pointing to `https://openrouter.ai/api/v1`), but this is completely disconnected from the server.

### How Prompts Are Structured

Prompts are **externally managed in LangSmith Hub** — they are not defined in the codebase:

- `data_checker:885899c9` — stage 1 relevance filter
- `respuesta_final:fca2401d` — stage 2 answer generation

Both are fetched at **request time** via `hub.pull()` from `langchain/hub/node` — `demo/rag.ts:153-156`. This means every request makes an additional network call to `https://eu.api.smith.langchain.com`.

The prompts are ChatPromptTemplates with SYSTEM + HUMAN messages. The `buildPrompt()` function — `demo/rag.ts:149-180` — concatenates all messages into a single flat string before passing to Gemini (because Gemini does not receive the ChatPromptValue directly). This is a workaround with a documented explanation in the code comments.

### Prompt Variables

**Stage 1 (`data_checker`):**
- `question` — the user's original question
- `retrieved_document` — formatted top-5 chunks from vector search

**Stage 2 (`respuesta_final`):**
- `question` — the user's original question
- `retrieved_document` — formatted 1-2 chunks selected by data_checker
- `client_name` — hardcoded as `"Vicky"`
- `mensaje_original` — currently set to `question` (comment notes: "will be replaced with real message when conversation layer is built")
- `contexto` — currently empty string (comment notes: "will be replaced with real context when conversation layer is built")

### Conversation History

**Not implemented.** Comments in `demo/rag.ts:235-236` acknowledge this explicitly:
```
// will be replaced with real message when conversation layer is built
// will be replaced with real context when conversation layer is built
```

Each request is entirely stateless. There is no session management, no conversation ID, no message history stored or retrieved.

### Vector Search Implementation

Vector search **is implemented** end-to-end:

1. **Embedding creation:** `embedQuestion()` — `demo/rag.ts:83-89` calls `gemini.models.embedContent()` with model `gemini-embedding-001`
2. **Storage:** PostgreSQL `document_chunks` table, `embedding` column of type `vector(768)`
3. **Index:** HNSW index using cosine distance ops (`vector_cosine_ops`) — created in `demo/migrate.ts:45-49`
4. **Retrieval:** Cosine similarity via pgvector operator `<=>` (cosine distance), returning top 5 results — `demo/rag.ts:96-108`
5. **Similarity displayed:** `1 - (embedding <=> $vector)` — converted to similarity score for logging

### LangSmith Integration

LangSmith is integrated for **two purposes:**

1. **Prompt storage and versioning:** Prompts are stored as pinned versions in LangSmith Hub and fetched at runtime
2. **Tracing:** The Gemini client is wrapped with `wrapGemini()` from `langsmith/wrappers/gemini` — `demo/rag.ts:54` — which automatically traces all Gemini calls to LangSmith

Configuration:
- `LANGSMITH_TRACING=true`
- `LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com` (EU data residency)
- `LANGSMITH_PROJECT=MiNatzig`

---

## 6. Code Quality Assessment

### Separation of Concerns

**Poor.** The entire server (`demo/rag.ts`) is a single 343-line file containing:
- Express app initialization and middleware
- Environment variable validation
- Database pool creation
- Gemini client initialization
- All database query functions
- All LLM call functions
- All prompt-fetching logic
- JSON parsing utilities
- HTTP route handler
- Server startup

There are no separate modules for configuration, database access, services, or routes.

### Async/Await Usage

Correct — all async operations use `async/await` properly. The route handler is an async function. No `.then()` chains mixed with `await`. No floating promises.

### Error Handling

**Partial.**

- The main route handler has a top-level `try/catch` that returns a 500 error — `demo/rag.ts:330-334`
- `runDataChecker()` catches JSON parse errors and returns `null` — `demo/rag.ts:218-222`
- `runRespuestaFinal()` catches JSON parse errors and falls back to raw text — `demo/rag.ts:243-250`
- **Missing:** No error handling on `embedQuestion()` — if the Gemini embedding call fails, the error propagates uncaught to the route handler's top-level catch, which returns a generic 500
- **Missing:** No error handling on `hub.pull()` — if LangSmith is unreachable, every request fails with a 500
- **Missing:** Pool-level error events not handled; an unhandled `error` event on a Node.js `EventEmitter` (which `Pool` extends) crashes the process
- `chunker.py:135-143`: Catches errors on chunk review and substitutes defaults — acceptable fallback

### Logging Quality

Console-only logging via `console.log`, `console.warn`, `console.error`. Emojis used as log-level indicators (`❓`, `📚`, `🔍`, etc.). No structured logging, no log levels, no timestamps, no request IDs, no log aggregation target.

### Input Validation

- **Server:** Only checks that `question` is present and non-empty — `demo/rag.ts:261`
- No maximum length check on `question` (unbounded embedding + LLM cost)
- No content type validation beyond what `express.json()` handles
- LLM-selected `chunk_id` values are used directly in DB queries without format validation

### Security Concerns

1. **Committed credentials** (`demo/.env`): DB password, Gemini API key, and LangSmith API key are all committed to version control. These are live credentials. This is the most severe security issue.
2. **Hardcoded API key** (`chunking_documentation/chunker.py:9`): `GEMINI_API_KEY` is hardcoded as a string literal — same key as in the `.env` file.
3. **No authentication on the API**: The `POST /ask` endpoint has no API key, no token, no session validation. Anyone with network access can call it.
4. **No CORS configuration**: Express 5 default behavior — no CORS headers set, no origin restriction.
5. **No HTTPS enforcement**: The server runs plain HTTP.
6. **Hardcoded absolute paths** in Python scripts reference `/Users/adinisman/...` — a different user's home directory. Scripts will fail as-is on any other machine.

### Scalability Concerns

- LangSmith `hub.pull()` is called twice per request (once for each prompt). This is a synchronous network call within the request lifecycle. Under load, this doubles request latency and creates a hard dependency on LangSmith availability.
- DB pool has no configured `max` — defaults to 10 connections, which is low for concurrent load.
- No caching of fetched prompts — the same pinned version is re-fetched from LangSmith on every request.
- Single-process Node.js — no clustering or process management configured.

### Tight Coupling

All concerns are coupled in a single file (`rag.ts`). Configuration constants are interleaved with business logic. The prompt commit hashes are hardcoded alongside the model names and client name.

### Global State

- `pool` — global DB connection pool — `demo/rag.ts:41`
- `db` — global Drizzle instance — `demo/rag.ts:49`
- `gemini` — global LangSmith-wrapped Gemini client — `demo/rag.ts:54`
- `app` — global Express app — `demo/rag.ts:255`

These are module-level singletons. For a single-process deployment this is acceptable, but it makes testing and modularization harder.

### TypeScript Strict Mode

Disabled — `demo/tsconfig.json:7`: `"strict": false`. This permits implicit `any`, missing null checks, and other unsafe patterns.

### Typo in Production Interface

`FinalAnswerResponse.docuementacion` — `demo/rag.ts:78`. The field name has a typo. The comment acknowledges this matches the LangSmith prompt intentionally, meaning the typo exists in the externally managed prompt and is propagated into the TypeScript type. This creates a maintenance hazard.

---

## 7. Production Readiness Assessment

### Can This Code Be Deployed As-Is?

**No.** The current state has multiple blockers for production deployment:

### What Would Break Under Load

- **LangSmith dependency per request:** Two `hub.pull()` network calls per request, with no caching or timeout. If LangSmith is slow or down, every in-flight request hangs until it times out.
- **Unbounded request processing time:** No timeout on Gemini API calls. A slow embedding or generation response holds the connection open indefinitely.
- **DB pool exhaustion:** Default 10-connection pool with no queuing limits. Under concurrent load, requests will queue or fail without graceful rejection.
- **No request queuing or concurrency limits:** All requests processed simultaneously. Memory grows linearly with concurrent requests.

### Missing Rate Limits

None. No per-IP limits, no global request limits, no token-per-minute tracking for Gemini API usage.

### Missing Authentication

None on the server. The `POST /ask` endpoint is fully open.

### Missing Validation

- No `question` length limit — a 100,000-character question will be embedded and processed
- No content-type enforcement beyond `express.json()` parsing
- No validation of LangSmith-returned prompt structure
- No validation of Gemini response structure before JSON parsing (handled by try/catch fallback, not schema validation)

### Missing Retry Logic

No retry on:
- Gemini embedding calls
- Gemini LLM calls
- LangSmith `hub.pull()` calls
- DB queries

### Blocking Synchronous Code

None identified. All I/O is async.

### Memory Risks

- No limit on the size of `question`, meaning large inputs create large embedding requests
- `buildPrompt()` logs up to 500 chars of each prompt per request — benign but contributes to log volume
- `formatChunks()` creates in-memory string concatenations of all chunk content — bounded by `TOP_K * chunk_size` which is manageable

### Other Missing Production Requirements

- No health check endpoint (`GET /health`)
- No graceful shutdown handler (SIGTERM/SIGINT)
- No structured logging or log aggregation
- No process manager (`pm2`, Docker, systemd) — no indication of deployment target
- No environment-specific configuration (dev vs. staging vs. prod)
- No test suite of any kind
- `package.json` has no `start` script — only a placeholder `test` script that exits with an error
- Python scripts have hardcoded absolute paths from a different developer's machine (`/Users/adinisman/...`)

---

## 8. Integration Feasibility

### Can This Be Used as a Standalone AI Microservice?

**Partially, with significant work.** The `demo/rag.ts` server is a functioning Express HTTP server with a single documented endpoint (`POST /ask`). The RAG pipeline logic is functional. However, it is not deployable as-is due to:

- Committed credentials that must be rotated
- No authentication layer
- No health/readiness endpoints expected by orchestrators (Kubernetes, ECS, etc.)
- Hard dependency on LangSmith availability at request time
- No Dockerfile, no deployment configuration

The core logic (embed → retrieve → filter → generate) is sound and could serve as a microservice **after** significant hardening.

### Can Parts Be Embedded Into an Existing Backend?

**Yes, selectively.** The following logic is reusable with extraction:

| Reusable Component | Current Location | What It Does |
|---|---|---|
| Vector retrieval | `retrieveChunks()` — `demo/rag.ts:93-109` | Cosine similarity search via pgvector |
| Chunk formatting | `formatChunks()` — `demo/rag.ts:134-141` | Formats DB rows into prompt-ready text |
| Two-stage LLM pipeline | `runDataChecker()` + `runRespuestaFinal()` | Relevance filter + answer generation |
| DB schema | `demo/schema.ts` | Drizzle ORM definition (with vector dimension fix needed) |
| Migration | `demo/migrate.ts` | One-time DB setup (table + HNSW index) |
| Ingestion pipeline | `chunking_documentation/` | Three-stage document ingestion pipeline |

### What Would Need Refactoring

- **Credentials:** All hardcoded/committed secrets must be rotated and removed from git history
- **LangSmith prompt caching:** `hub.pull()` must be cached at startup or use a CDN/cache layer — not called per request
- **Modularization:** Extract DB layer, embedding service, LLM service, and HTTP layer into separate modules
- **Authentication:** Add API key or token-based authentication to the endpoint
- **Schema correction:** Fix `vector(3072)` in `schema.ts` to match the actual `vector(768)` used in migration and model output
- **Conversation layer:** The `contexto` and `mensaje_original` variables are placeholders — the conversation management system is not built
- **Client name:** `CLIENT_NAME` must be configurable, not hardcoded
- **Error handling:** Add timeouts and retry logic to all external calls
- **Python paths:** Replace hardcoded absolute paths in ingestion scripts with configurable paths

### What Parts Are Reusable

- The **two-stage RAG pipeline concept** (relevance filter before final generation) is a well-reasoned pattern and worth preserving
- The **HNSW index setup** and vector search query are correct and performant
- The **chunk enrichment pipeline** (context injection for non-self-contained chunks) adds meaningful quality improvement and is reusable
- The **LangSmith tracing integration** (`wrapGemini`) provides observability at low cost

### What Parts Should Be Discarded or Replaced

- `main.py` and `debug.py` — prototype scripts, not part of any deployable system
- The hardcoded Python file paths in `chunker.py` and `embed_and_insert.py`
- The single-file architecture of `rag.ts` — needs proper layering before any further development
- The absence of a `start` script and lack of process management

---

## Summary Table

| Dimension | Status |
|---|---|
| Functional RAG pipeline | Implemented |
| Conversation history | Not implemented |
| Authentication | Not implemented |
| Rate limiting | Not implemented |
| Prompt caching | Not implemented |
| Test suite | Not implemented |
| Structured logging | Not implemented |
| Health check endpoint | Not implemented |
| Graceful shutdown | Not implemented |
| Secret management | **Critical failure — credentials committed to git** |
| Schema consistency | **Bug — vector dimensions mismatch between schema.ts and migrate.ts** |
| Deployment configuration | Not present |
| TypeScript strict mode | Disabled |
| Error handling coverage | Partial |
| Separation of concerns | Poor — monolithic single file |
