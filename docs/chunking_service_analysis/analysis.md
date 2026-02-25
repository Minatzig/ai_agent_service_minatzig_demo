# Chunking Service — Technical Analysis

**Date:** 2026-02-25
**Analyst:** Senior Backend Engineer / Technical Review
**Status:** Read-only analysis — no modifications made to source code

---

## Files Inspected

| File | Role |
|---|---|
| `chunking_documentation/markdown_converter.py` | Stage 0 — Converts PDF/DOCX source files to Markdown |
| `chunking_documentation/chunker.py` | Stage 1 — Main entry point: reads Markdown, splits via LLM, enriches chunks, writes JSON |
| `chunking_documentation/embed_and_insert.py` | Stage 2 — Reads JSON, generates embeddings via Gemini, inserts into PostgreSQL |
| `chunking_documentation/.gitignore` | Ignores `.env` files in this subdirectory |
| `docs/investigation/project-investigation.md` | Prior full-project technical investigation (used for cross-reference) |

**Main entry point identified:** `chunking_documentation/chunker.py` — this is the core chunking service. It is run as a standalone script (`python chunker.py`) and is the only stage that produces the chunk data used by all downstream consumers.

---

## Table of Contents

1. [What the Service Does Today](#1-what-the-service-does-today)
2. [Risks, Bugs, and Edge Cases](#2-risks-bugs-and-edge-cases)
3. [Proposed Improvements for Production](#3-proposed-improvements-for-production)
4. [Next Step: Storing Chunks in Remote Postgres](#4-next-step-storing-chunks-in-remote-postgres)

---

## 1. What the Service Does Today

### 1.1 Pipeline Overview and Stage Sequence

The chunking service is not a single script — it is a **three-stage offline pipeline**, all under `chunking_documentation/`. Each stage is a standalone Python script executed manually in order:

```
Stage 0: markdown_converter.py
    Input : INPUT_FOLDER/*.pdf, INPUT_FOLDER/*.docx
    Output: INPUT_FOLDER/*.md (converted Markdown files, written into the same input folder)

Stage 1: chunker.py                          ← PRIMARY SUBJECT OF THIS ANALYSIS
    Input : INPUT_FOLDER/*.md
    Output: OUTPUT_FOLDER/<stem>_chunks.json (per-file)
            OUTPUT_FOLDER/all_chunks.json    (combined)

Stage 2: embed_and_insert.py
    Input : CHUNKS_FILE (hardcoded path to all_chunks.json)
    Output: Rows inserted into PostgreSQL document_chunks table
```

There is no orchestration layer, no Makefile, no scheduler, and no pipeline manager. The three scripts must be run manually in the correct order. No mechanism prevents running them out of order.

### 1.2 Entry Point and Execution Flow — `chunker.py`

**Execution trigger:** `python chunker.py` (direct script execution via `if __name__ == "__main__":`).

**Step-by-step flow:**

1. Load environment variables via `python-dotenv` (`load_dotenv()`).
2. Read `GEMINI_API_KEY` from environment — crashes with `KeyError` if absent.
3. Read hardcoded `INPUT_FOLDER` and `OUTPUT_FOLDER` constants from source code.
4. Initialize the `google.genai.Client` with the API key.
5. Scan `INPUT_FOLDER` for all `*.md` files using `Path.glob("*.md")`.
6. If no `.md` files are found, print a warning and exit.
7. For each `.md` file:
   - Determine `doc_type` by keyword matching against the filename.
   - Call `process_document(filepath, doc_type)`:
     - Open and read the full file as UTF-8 text.
     - Send the entire document text to Gemini (`gemini-2.5-flash`) with a splitting prompt.
     - Parse the LLM JSON response to get a list of `{ title, content }` sections.
     - For each section, send the section to Gemini again with a review/enrichment prompt.
     - Assemble a chunk dict with all metadata fields and a generated UUID.
   - Write per-file JSON to `OUTPUT_FOLDER/<stem>_chunks.json`.
   - Append chunks to `all_chunks` accumulator list.
8. Write combined `all_chunks` list to `OUTPUT_FOLDER/all_chunks.json`.
9. Print a summary (files processed, total chunks, enriched chunk count).

### 1.3 Supported File Types and Parsing Strategy

**In `chunker.py`:** Only `*.md` (Markdown) files. No other file types are detected or processed.

**In `markdown_converter.py` (Stage 0):**
- `*.pdf` — converted using `pymupdf4llm.to_markdown()`. This library attempts structure-preserving PDF-to-Markdown conversion.
- `*.docx` — converted using the `docx` library: paragraphs are extracted as plain text (non-empty only), joined with double newlines, then converted to Markdown via `markdownify`.

**What is not supported at any stage:**
- `.txt`, `.html`, `.xlsx`, `.csv`, `.pptx`, scanned PDFs (image-only), encrypted PDFs, RTF files, or any other format.
- Binary files passed to `chunker.py` would cause a UTF-8 decode error when opened.

**Parsing strategy:** There is no structural parsing of Markdown (no heading-level splitting, no regex-based paragraph splitting). The entire document text is handed to the LLM as a single prompt, and the LLM is responsible for identifying section boundaries. This is semantic chunking, not rule-based chunking.

### 1.4 Chunking Algorithm

**Algorithm type:** LLM-semantic splitting (two-pass).

**Pass 1 — Splitting (`split_document_with_llm`):**
- The full document text is sent to `gemini-2.5-flash` in a single prompt.
- The prompt instructs the model to split the document into logical, self-contained sections of 2-3+ sentences.
- The model is instructed to keep tables together with their title and context.
- The response must be a raw JSON array of `{ title, content }` objects.
- A cleanup step strips accidental markdown fences (` ```json `, ` ``` `) from the response before parsing.

**Pass 2 — Review and enrichment (`review_chunk`):**
- Each section from Pass 1 is sent individually to `gemini-2.5-flash`.
- Up to 1,500 characters of the preceding section's content is included as context.
- The model assesses whether the chunk is self-contained. If not, it rewrites the chunk by prepending a brief context sentence.
- The response is a JSON object with: `self_contained`, `missing_context`, `summary`, `enriched_text`.

**Chunk size:** Entirely determined by the LLM — no `chunk_size`, `overlap`, or token-limit parameter is configured. Chunk size is unbounded and non-deterministic.

**Overlap:** None. Chunks are discrete. Adjacent sections share no text. The only cross-chunk mechanism is the context injection in Pass 2, which prepends a sentence to non-self-contained chunks.

**Section boundaries:** Determined semantically by the LLM based on the document's headings, numbered items, bold titles, and topic changes (as instructed in the prompt).

### 1.5 Metadata Per Chunk

Each output chunk is a dict with the following fields:

| Field | Source | Type | Notes |
|---|---|---|---|
| `chunk_id` | `uuid.uuid4()` | string (UUID4) | Non-deterministic — changes every run |
| `source_file` | `os.path.basename(filepath)` | string | Filename only, no directory |
| `doc_type` | `get_doc_type(filename)` | string | Keyword-matched from filename |
| `section_title` | LLM (Pass 1) | string | LLM-assigned; defaults to `"Section N"` if missing |
| `chunk_index` | Loop index `i` | integer | 0-based position within the document |
| `self_contained` | LLM (Pass 2) | boolean | Whether chunk needs context injection |
| `missing_context` | LLM (Pass 2) | string or null | Description of what context was missing |
| `summary` | LLM (Pass 2) | string | One-sentence summary of what the chunk answers |
| `text` | LLM (Pass 2) `enriched_text` | string | Final chunk text, possibly prepended with context |
| `embed_input` | Assembled in code | string | `summary + "\n\n" + enriched_text` — used for embedding |

**`doc_type` classification logic (`get_doc_type`):**
- Filename contains `"faq"` → `"faq"`
- Filename contains `"error"` → `"error_guide"`
- Filename contains `"cartilla"` → `"user_guide"`
- Filename contains `"comunicacion"` → `"regulation"`
- Filename contains `"manual"` → `"manual"`
- Otherwise → `"manual"` (default)

Matching is case-insensitive (`filename.lower()`). Checks are evaluated top-to-bottom with no priority resolution — a file named `"error_manual.md"` matches `"error"` first and gets `"error_guide"`.

### 1.6 Output Format and Write Location

**Per-file output:** `OUTPUT_FOLDER/<source_stem>_chunks.json`
- JSON array of chunk dicts.
- Written with `indent=2` and `ensure_ascii=False` (supports non-ASCII/UTF-8 content).
- File is written after each document is processed.

**Combined output:** `OUTPUT_FOLDER/all_chunks.json`
- JSON array of all chunks from all processed files.
- Written once at the end after all files are processed.
- If the process is interrupted after processing some files, the `all_chunks.json` is not written, but per-file JSONs are.

`OUTPUT_FOLDER` is hardcoded as a string literal: `/Users/adinisman/Downloads/` in `chunker.py:15`. This path refers to a different developer's home directory.

### 1.7 Error Handling and Retries

**In `chunker.py`:**
- `split_document_with_llm`: No try/catch. If the Gemini API call fails, the exception propagates and the entire script crashes. No retry logic.
- `review_chunk`: No try/catch. Propagates exceptions upward.
- In `process_document`, the call to `review_chunk` is wrapped in a `try/except (json.JSONDecodeError, Exception)`. On any error, the chunk falls back to a default `review` dict (marks as self-contained, uses title as summary, uses raw body as text). This is the only error recovery path.
- No retry on Gemini API calls anywhere in the pipeline.
- No handling of Gemini rate limit errors (HTTP 429).

**In `markdown_converter.py`:**
- PDF and DOCX conversions are individually wrapped in `try/except Exception`. A failed conversion prints a warning and continues to the next file.

**In `embed_and_insert.py`:**
- Each chunk's embedding + insert is wrapped in a `try/except Exception`. On error, the chunk is skipped, the DB transaction is rolled back, and processing continues.
- A `time.sleep(0.5)` is placed after each successful insert to manually throttle Gemini embedding API calls.

**Summary:** There are no retries anywhere. Error handling is minimal in the chunker and present only for individual-item failures in the embedder.

### 1.8 Performance Characteristics and Scalability

**API calls per document:**
- 1 Gemini LLM call for splitting (Pass 1)
- N Gemini LLM calls for enrichment (Pass 2), where N = number of sections identified

**API calls per run:**
- Total LLM calls = `sum(1 + len(sections_per_doc))` across all documents
- Total embedding calls (Stage 2) = total number of chunks

**Memory:** The entire file is read into memory as a string before being sent to the LLM. For very large files (tens of MB), this risks exceeding Gemini's context window limit (unknown exact limit for `gemini-2.5-flash` at time of writing; typically 1M tokens for flash variants). The script does not check document length before submitting.

**CPU:** Negligible — all heavy work is delegated to the Gemini API (network I/O bound).

**IO:** Sequential, single-threaded. Files are processed one at a time; sections within a file are reviewed one at a time. No parallelism or batching.

**Scalability limits:**
- A corpus of 100 documents with 20 sections each = 2,100 Gemini API calls at Stage 1, plus 2,000 embedding calls at Stage 2.
- With a 0.5s sleep between embeddings (Stage 2), 2,000 chunks = ~17 minutes of wall-clock time, ignoring API latency.
- No mechanism to resume from a checkpoint if interrupted.
- Processing is entirely serial — adding more documents increases time linearly.

### 1.9 Configuration and Environment Variables

| Name | Used In | How Set | Value |
|---|---|---|---|
| `GEMINI_API_KEY` | `chunker.py:12`, `embed_and_insert.py:20` | `os.environ["GEMINI_API_KEY"]` (env var); **also hardcoded as a string literal in `chunker.py:12` via the assignment at line 9** | Real key committed to repo |
| `INPUT_FOLDER` | `chunker.py:14`, `markdown_converter.py:7` | **Hardcoded string literal in source code** — not an env var | `/Users/alenwuhl/Downloads/dynatech-data/` (chunker.py); `/Users/adinisman/Downloads/dynatech/input_docs` (markdown_converter.py) |
| `OUTPUT_FOLDER` | `chunker.py:15`, `markdown_converter.py:8` | **Hardcoded string literal in source code** — not an env var | `/Users/adinisman/Downloads/` (chunker.py) |
| `CHUNKS_FILE` | `embed_and_insert.py:21` | **Hardcoded string literal** | `/Users/adinisman/Downloads/dynatech/output_docs/all_chunks.json` |
| `DB_HOST` | `embed_and_insert.py:37` | `os.environ["DB_HOST"]` | Unknown — not in chunking_documentation/.env |
| `DB_PORT` | `embed_and_insert.py:38` | `os.environ["DB_PORT"]` | Unknown |
| `DB_NAME` | `embed_and_insert.py:39` | `os.environ["DB_NAME"]` | Unknown |
| `DB_USER` | `embed_and_insert.py:40` | `os.environ["DB_USER"]` | Unknown |
| `DB_PASSWORD` | `embed_and_insert.py:41` | `os.environ["DB_PASSWORD"]` | Unknown |

**Unknown:** The `.gitignore` in `chunking_documentation/` ignores `.env`, implying there may be a local `.env` file in that directory, but no committed copy exists. Whether a `.env` file is expected there or whether the demo `demo/.env` is used by these scripts is unknown without running the scripts.

**Critical note on `INPUT_FOLDER`:** The `INPUT_FOLDER` constant in `chunker.py:14` is set to `/Users/alenwuhl/Downloads/dynatech-data/` (the current developer's path). The same constant in `markdown_converter.py:7` points to `/Users/adinisman/Downloads/dynatech/input_docs` (a different developer). These two paths are inconsistent — Stage 0 would look for source files in a different location than Stage 1 expects Markdown outputs.

---

## 2. Risks, Bugs, and Edge Cases

### 2.1 Encoding Issues

- Files are opened with `encoding='utf-8'` (explicit). This will raise `UnicodeDecodeError` for files encoded in ISO-8859-1, Windows-1252, or other Latin encodings. There is no fallback encoding and no error handling around file open.
- `ensure_ascii=False` is correctly set for JSON output, so non-ASCII characters are preserved in the output.
- PDFs with non-UTF-8 text layers: `pymupdf4llm` handles encoding internally; its behavior on malformed or non-standard encodings is unknown from the source code alone.

### 2.2 Large Files

- The entire file text is loaded into memory and sent in a single Gemini API call. There is no check against Gemini's context window limit before submitting.
- If the document exceeds the LLM's context window, the API call will fail with an error. Since there is no try/catch around `split_document_with_llm`, the script crashes and all subsequent files in the batch are skipped.
- There is no chunking-before-chunking strategy (e.g., splitting large files into windows before LLM submission).

### 2.3 Binary Files

- `chunker.py` will attempt to open any `*.md` file in the folder as UTF-8 text. A binary file with a `.md` extension would cause a `UnicodeDecodeError` crash.
- `markdown_converter.py` explicitly targets `.pdf` and `.docx` only, which are handled with appropriate libraries.

### 2.4 PDFs

- Image-only (scanned) PDFs: `pymupdf4llm` extracts the text layer. If no text layer exists (pure image scan), the output will be empty or near-empty Markdown. This will result in a Gemini LLM call with no content, an empty sections list, and a silent skip of that file. No warning is issued for zero-content documents.
- Encrypted/password-protected PDFs: behavior is unknown from source; `pymupdf4llm` may raise an exception (caught by Stage 0's per-file try/catch) or return empty content.
- Complex multi-column PDFs: `pymupdf4llm` attempts structure preservation, but multi-column layout fidelity is unknown.

### 2.5 Empty Files

- An empty `.md` file: `split_document_with_llm` receives an empty string. The LLM may return an empty array `[]`, triggering the `if not sections` guard which prints a warning and returns `[]`. This is handled. However, the LLM could also return a non-empty array with empty `content` fields, which would be silently skipped by the `if not body.strip(): continue` guard.
- An empty PDF yields an empty Markdown output file, which is then treated as an empty `.md` file (handled as above).

### 2.6 Duplicate Ingestion

- **Chunk IDs are non-deterministic.** Every run of `chunker.py` generates new UUID4 values for all chunks, even for files that have not changed.
- Running `chunker.py` twice on the same files produces two entirely different sets of chunk IDs.
- In Stage 2, `embed_and_insert.py` uses `ON CONFLICT (chunk_id) DO NOTHING`. Since chunk IDs change on every run, this conflict resolution is effectively inoperative for deduplication across runs — each re-run inserts an entirely new set of rows.
- **There is no deduplication by `source_file + chunk_index` or by content hash.** Re-running the pipeline on unchanged files will duplicate all data in the database.

### 2.7 Idempotency

- The pipeline is **not idempotent.** Re-running it on the same input:
  - Produces different JSON files (different UUIDs).
  - Inserts new (duplicate) rows into the database on each run.
  - Does not delete or replace existing rows for the same `source_file`.

### 2.8 Ordering

- Files are processed in the order returned by `Path.glob("*.md")`. The ordering of `glob` is filesystem-dependent (often inode order, not alphabetical). The processing order is not guaranteed and not logged.
- `chunk_index` is the 0-based index within a single document's section list. It is meaningful only relative to its `source_file`. There is no global ordering field across the corpus.

### 2.9 Concurrency

- The pipeline is single-process and single-threaded within each script.
- There is no locking mechanism on the input or output folders.
- If two instances of `chunker.py` run concurrently, they will both write to the same output files. The per-file JSON writes use a `with open(..., 'w')` pattern — each write truncates and rewrites the file. Two concurrent writes to the same file will corrupt it (last write wins, with possible interleaving at the OS level).
- The final `all_chunks.json` write has the same race condition.
- Database inserts in `embed_and_insert.py` with the same `ON CONFLICT (chunk_id) DO NOTHING` clause would not cause correctness issues from concurrency (UUIDs are unique), but could silently skip rows if two identical chunk IDs are inserted simultaneously (effectively impossible given UUID4 entropy).

### 2.10 LLM Output Reliability

- Both LLM calls expect valid JSON responses. The code strips markdown fences before parsing, but any other deviation from expected JSON format causes a `json.JSONDecodeError`:
  - In `split_document_with_llm`: unhandled — crashes the entire document processing.
  - In `review_chunk`: caught in `process_document` and replaced with a default safe value.
- The LLM may return sections with missing keys (`title` or `content`). The code uses `.get()` with defaults for both fields, handling this safely.
- The LLM may hallucinate or modify text rather than copying it verbatim (despite the "copied verbatim" instruction). There is no validation that `content` in Pass 1 is actually a substring of the original document.

### 2.11 Logging Gaps and Observability

- All logging is via `print()` statements with emoji prefixes (`📄`, `✅`, `⚠️`). No log levels, no timestamps, no structured output.
- No request IDs or correlation IDs across the pipeline stages.
- No logging of Gemini API call durations or response sizes.
- No logging of file sizes or token estimates before LLM submission.
- The number of API calls made is not logged, making cost tracking impossible without external tooling.
- Errors in `split_document_with_llm` produce no log output before crashing — the Python traceback is the only signal.
- Stage 2 logs per-chunk progress but does not log total elapsed time or throughput.

---

## 3. Proposed Improvements for Production

### 3.1 Clean Architecture Separation

The pipeline should be refactored into four distinct, independently testable components:

**Reader** — responsible for file discovery and raw text extraction:
- Inputs: a folder path and a list of allowed extensions
- Outputs: `(filename, raw_text, detected_encoding)` tuples
- Encapsulates file open, encoding detection (e.g., via `chardet`), and error handling
- No LLM knowledge, no chunking logic

**Parser** — responsible for format-specific conversion to plain text or Markdown:
- Wraps `pymupdf4llm`, `python-docx`, and Markdown passthrough
- Returns normalized text regardless of input format
- Separately testable with fixture files

**Chunker** — responsible for splitting and enriching text into chunk objects:
- Inputs: normalized text, filename, doc_type
- Outputs: a list of `Chunk` dataclass/TypedDict objects with all metadata fields
- Contains all LLM interaction logic
- Should accept an injectable LLM client for testing (dependency injection pattern)

**Writer** — responsible for persisting chunks:
- Inputs: a list of `Chunk` objects and a destination (local JSON or database)
- Outputs: write confirmation or error
- Should support idempotent writes (upsert by deterministic ID)
- Separately testable with a mock destination

A CLI entry point or orchestrator script ties these together without containing any business logic itself.

### 3.2 Deterministic Chunk IDs and Idempotent Writes

**Replace `uuid.uuid4()` with a deterministic hash-based ID:**
- Input to the hash: `source_file + chunk_index + content_hash(text)`
- Algorithm: SHA-256 of the concatenated string, truncated to 32 hex chars or formatted as a UUID5
- Result: the same chunk, on the same file, at the same position, with the same content always produces the same ID

**Idempotent upsert on write:**
- Database: `INSERT INTO ... ON CONFLICT (chunk_id) DO UPDATE SET text = EXCLUDED.text, ...`
- This means re-running the pipeline on unchanged files is a no-op; re-running after file changes updates existing rows
- Files that no longer exist in the input folder can be cleaned up via a separate reconciliation step (`DELETE FROM document_chunks WHERE source_file NOT IN (...)`)

### 3.3 Configuration via Environment Variables

All hardcoded paths and constants must be replaced with environment variables:

- `INPUT_FOLDER` → `CHUNKER_INPUT_FOLDER`
- `OUTPUT_FOLDER` → `CHUNKER_OUTPUT_FOLDER` (for intermediate JSON; may be eliminated if writing directly to DB)
- `GEMINI_API_KEY` → already read from env in part; remove the hardcoded literal entirely
- `GEMINI_MODEL` → configurable model name (currently hardcoded as `"gemini-2.5-flash"`)
- `DB_*` variables → already env-driven in Stage 2; Stage 1 should also use them if writing directly

A `config.py` or `settings.py` module should centralize all configuration loading with explicit validation and meaningful error messages at startup.

### 3.4 Structured Logging and Metrics

Replace `print()` statements with Python's `logging` module:
- Log levels: `DEBUG`, `INFO`, `WARNING`, `ERROR`
- Format: JSON-structured (timestamp, level, message, key-value context fields)
- Each file processed: log filename, file size, number of sections, elapsed time
- Each API call: log model, input token estimate, response time, success/failure
- Each chunk: log chunk ID, section title, character count

Metrics to expose (even as log lines initially):
- Total files processed / skipped / errored
- Total chunks produced / enriched / failed
- Total Gemini API calls and estimated cost tokens
- Total elapsed wall-clock time per stage

### 3.5 Retry Logic with Exponential Backoff

All external API calls (Gemini LLM, Gemini Embedding) should be wrapped with a retry decorator:
- Max retries: 3
- Backoff: exponential (e.g., 1s, 2s, 4s)
- Retry conditions: HTTP 429 (rate limit), HTTP 5xx (server error), transient network errors
- Non-retriable: HTTP 400 (bad request), HTTP 401 (auth failure)

The `tenacity` library is the standard tool for this in Python.

### 3.6 Safe Handling of Secrets

- Remove the hardcoded `GEMINI_API_KEY` literal from `chunker.py` entirely
- Load all secrets exclusively via `os.environ` with explicit `KeyError` handling that prints a clear message
- Add `chunking_documentation/.env` to `.gitignore` (already present) and add a `.env.example` file documenting all required variables
- Confirm `demo/.env` is removed from git history via `git filter-repo` or `BFG Repo Cleaner`

### 3.7 Test Strategy

**Unit tests (no network, no filesystem):**

| Test Case | Component | What to Mock |
|---|---|---|
| `get_doc_type` returns correct type for each keyword | `chunker.py` | Nothing |
| `get_doc_type` returns `"manual"` for unknown filenames | `chunker.py` | Nothing |
| `process_document` skips sections with empty body | Chunker | LLM client |
| `process_document` uses fallback on LLM review error | Chunker | LLM client raises exception |
| `process_document` returns empty list when LLM returns no sections | Chunker | LLM client |
| Deterministic chunk ID is stable across two calls | Chunk ID generator | Nothing |
| Deterministic chunk ID changes when content changes | Chunk ID generator | Nothing |
| `convert_docx` extracts text from paragraphs correctly | Parser | Nothing (use fixture .docx) |
| `split_document_with_llm` strips markdown fences from LLM response | Chunker | LLM client |

**Integration tests (real filesystem, mocked LLM):**

| Test Case | What to Test |
|---|---|
| Full pipeline on a fixture `.md` file produces expected chunk count | End-to-end pipeline with mocked LLM |
| Pipeline skips empty files without crashing | Empty fixture file |
| Pipeline handles UTF-8 file correctly | Fixture with special characters |
| Per-file JSON is written correctly | File content and structure |
| `all_chunks.json` contains chunks from all files | Combined output integrity |

**End-to-end tests (real LLM, real DB — optional, run in CI against a test DB):**

| Test Case | What to Test |
|---|---|
| Pipeline inserts rows into test DB correctly | Full pipeline with real Gemini and test Postgres |
| Re-running pipeline on unchanged file is a no-op (idempotent) | Requires deterministic IDs |
| Re-running pipeline after file change updates rows | Requires upsert behavior |

---

## 4. Next Step: Storing Chunks in Remote Postgres

### 4.1 Recommended Database Schema

**Table: `document_chunks`**

The existing schema (visible in `demo/schema.ts` and `demo/migrate.ts`) is a solid starting point. The following is the production-recommended version with corrections and additions:

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `chunk_id` | `TEXT` | PRIMARY KEY | Deterministic hash-based ID (see §3.2) |
| `source_file` | `TEXT` | NOT NULL | Original filename (basename only) |
| `source_path` | `TEXT` | NOT NULL | Full relative path from corpus root |
| `doc_type` | `TEXT` | NOT NULL | e.g., `faq`, `manual`, `error_guide`, `user_guide`, `regulation` |
| `section_title` | `TEXT` | NOT NULL | LLM-assigned title |
| `chunk_index` | `INTEGER` | NOT NULL | 0-based position within the source file |
| `self_contained` | `BOOLEAN` | NOT NULL DEFAULT true | Whether context injection was needed |
| `missing_context` | `TEXT` | nullable | Description of missing context; null if self-contained |
| `summary` | `TEXT` | NOT NULL | One-sentence summary used in embed_input |
| `text` | `TEXT` | NOT NULL | Final chunk text (enriched if needed) |
| `embed_input` | `TEXT` | NOT NULL | `summary + "\n\n" + text` — input string used for embedding |
| `embedding` | `vector(768)` | nullable | Embedding vector from `gemini-embedding-001` |
| `file_hash` | `TEXT` | NOT NULL | SHA-256 of the source file content at time of processing |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | Row insertion timestamp |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT now() | Row last-update timestamp |

**Indexes:**

```
PRIMARY KEY on chunk_id
INDEX ON (source_file)                             -- fast lookup by file
INDEX ON (doc_type)                                -- filter by document category
INDEX ON (source_file, chunk_index)               -- ordered retrieval within a file
HNSW INDEX ON embedding vector_cosine_ops          -- approximate nearest-neighbor search
```

The HNSW index (`m=16, ef_construction=64`) matches what is already present in `demo/migrate.ts`. Parameters may be tuned based on corpus size.

**Auxiliary table: `ingestion_log`** (recommended addition)

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | Primary key |
| `source_file` | `TEXT` | Filename processed |
| `file_hash` | `TEXT` | SHA-256 of file at time of run |
| `chunks_upserted` | `INTEGER` | Number of rows written |
| `chunks_deleted` | `INTEGER` | Number of stale rows removed |
| `status` | `TEXT` | `success` or `error` |
| `error_message` | `TEXT` | nullable |
| `started_at` | `TIMESTAMPTZ` | |
| `finished_at` | `TIMESTAMPTZ` | |

This log enables idempotency checking (skip re-processing unchanged files) and provides an audit trail.

### 4.2 Storing Raw Text, Metadata, and Embeddings-Ready Fields

The schema above already separates these concerns:
- **Raw text:** `text` column — the final chunk content
- **Metadata:** `source_file`, `source_path`, `doc_type`, `section_title`, `chunk_index`, `self_contained`, `missing_context`, `file_hash`, `created_at`, `updated_at`
- **Embedding input:** `embed_input` — the denormalized string used to generate the embedding (stored to enable re-embedding without re-chunking if the model changes)
- **Embedding vector:** `embedding` — the vector itself, stored as `vector(768)` for pgvector

**Embeddings-ready design:**
- Storing `embed_input` separately from `text` allows switching embedding models without re-running the LLM chunking stage.
- If the embedding model changes (e.g., to a 1536-dimension model), the `embedding` column can be re-generated from `embed_input` alone.
- Adding a `embedding_model` column (e.g., `TEXT DEFAULT 'gemini-embedding-001'`) enables tracking which model was used and filtering by model version.

### 4.3 Migration Strategy

**Step 1 — Enable pgvector:**
Already handled by `demo/migrate.ts`. Ensure the remote Postgres instance has the pgvector extension installed and enabled (`CREATE EXTENSION IF NOT EXISTS vector`).

**Step 2 — Create tables:**
Write a migration script (or use Drizzle migrations) that:
- Creates `document_chunks` with the schema above
- Creates `ingestion_log`
- Creates all indexes
- Migration should be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)

**Step 3 — Fix the existing schema mismatch:**
The existing `demo/schema.ts` defines the vector column as `vector(3072)` but the actual column and model output are `vector(768)`. The Drizzle schema file must be corrected before it can be used to generate accurate migrations.

**Step 4 — Adopt a migration tool:**
Use Drizzle Kit (`drizzle-kit migrate`) or Flyway/Liquibase. Do not rely on manual one-time scripts. Each schema change should be a numbered, tracked migration file committed to version control.

### 4.4 Batching Strategy for Inserts

The current `embed_and_insert.py` inserts one row at a time with a commit after each row. For production:

- **Batch embedding:** Gemini's `embed_content` API accepts a single text per call. Batch multiple embedding calls concurrently using `asyncio` with a semaphore to respect rate limits (e.g., max 10 concurrent calls), rather than sequential calls with a fixed sleep.
- **Batch DB inserts:** Accumulate chunks into batches of N (e.g., 50) and use a single multi-row `INSERT` statement per batch. This reduces round-trips and transaction overhead significantly.
- **Transaction scope:** Wrap each batch in a single transaction. On error, roll back only the batch, not the entire run.
- **Commit frequency:** Commit after each batch, not after each row.

**Recommended insert pattern:**
- Fetch embeddings for batch of N chunks (concurrent API calls)
- Execute single `INSERT ... ON CONFLICT DO UPDATE` for all N rows in one statement
- Log batch completion with count and timing
- Proceed to next batch

### 4.5 Handling Updates When Files Change

**Detection of file changes:**
- At the start of each pipeline run, compute `SHA-256` of each source file.
- Query `ingestion_log` for the last successful run's `file_hash` for that `source_file`.
- If hashes match → skip the file (no re-processing needed).
- If hashes differ (or no prior run exists) → re-process the file.

**Updating changed files:**
- Re-run the full chunking pipeline for the changed file.
- Insert new chunks using `ON CONFLICT (chunk_id) DO UPDATE` (upsert). Since chunk IDs are deterministic (see §3.2), sections that are unchanged produce the same ID and update in place. New sections are inserted. Removed sections need explicit cleanup.
- To remove stale chunks: after upserting all new chunks for a file, delete rows where `source_file = $file AND chunk_id NOT IN ($new_chunk_ids)`. This handles section deletions and reorders.

**Handling deleted source files:**
- Maintain a list of currently active source files.
- After processing all files, run: `DELETE FROM document_chunks WHERE source_file NOT IN ($active_files)`.
- Log deleted rows to `ingestion_log`.

**Summary of idempotency guarantees (post-improvements):**
- Unchanged file, re-run → zero DB changes (hash check skips processing)
- Changed file, re-run → stale rows updated or deleted, new rows inserted
- Deleted file, re-run → all rows for that file removed
- Script interrupted mid-run → next run resumes safely (no partial state corruption, no duplicate rows)

---

## Appendix: Summary of Current vs. Target State

| Dimension | Current State | Target State |
|---|---|---|
| Entry point | Manual script execution | CLI with `--input`, `--output`, `--env` flags |
| File discovery | Hardcoded folder path in source | `CHUNKER_INPUT_FOLDER` env var |
| Supported formats (full pipeline) | PDF, DOCX (via Stage 0), MD | Same + encoding detection |
| Chunk ID | Non-deterministic UUID4 | Deterministic SHA-256 hash |
| Idempotency | None — duplicates on re-run | Full idempotency via hash comparison |
| Error handling | Crashes on LLM split failure | Retry with backoff; skip + log on persistent failure |
| Retries | None | Exponential backoff via `tenacity` |
| Logging | `print()` with emojis | Structured JSON logs with log levels |
| Config | Hardcoded literals in source | All via environment variables |
| Architecture | Monolithic flat scripts | Reader / Parser / Chunker / Writer layers |
| DB writes | One row per transaction | Batched multi-row upserts |
| File change detection | None | SHA-256 hash comparison via `ingestion_log` |
| Test coverage | None | Unit + integration test suite |
| Secret handling | API key hardcoded in source | `os.environ` only, with `.env.example` |
| Concurrency | Single-threaded, no locking | Async embedding calls; file-level locking for safety |
