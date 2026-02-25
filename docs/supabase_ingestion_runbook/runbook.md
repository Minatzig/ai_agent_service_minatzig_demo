# Supabase Ingestion Runbook

**Date:** 2026-02-25
**Target:** Supabase Postgres (remote) with pgvector extension
**Pipeline:** `chunking_documentation/` — three Python scripts run locally in sequence

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Environment Variables](#2-environment-variables)
3. [Supabase Schema Setup (SQL Editor)](#3-supabase-schema-setup-sql-editor)
4. [Running the Pipeline](#4-running-the-pipeline)
5. [Expected Outputs](#5-expected-outputs)
6. [Verifying the Data in Supabase](#6-verifying-the-data-in-supabase)
7. [Idempotency — How Re-Runs Behave](#7-idempotency--how-re-runs-behave)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Prerequisites

### Python packages

All three scripts require the following packages. Install them once into your Python environment:

```
pip install google-genai psycopg2-binary python-dotenv pymupdf4llm python-docx markdownify
```

### Python version

No version is pinned in the scripts. Python 3.10+ is recommended. Verify with:

```
python --version
```

### Source documents

Place all source files you want to ingest inside the folder you will configure as `CHUNKER_INPUT_FOLDER`. Supported formats:
- `.pdf` — converted by Stage 0
- `.docx` — converted by Stage 0
- `.md` — used directly by Stage 1 (skip Stage 0 if all files are already Markdown)

**Assumption:** your source documents are already in `CHUNKER_INPUT_FOLDER` before you begin.

### Network

You are on IPv4-only. Direct `psql` from terminal to Supabase may be unreliable. All schema setup is done via the **Supabase SQL Editor** in the browser. Python scripts connect via `psycopg2` with `sslmode=require`, which works reliably over standard TCP/IPv4.

---

## 2. Environment Variables

### Required variables

All scripts load their configuration from `chunking_documentation/.env` via `python-dotenv`. The scripts fail immediately at startup with a clear message if any required variable is missing.

| Variable | Required by | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | chunker.py, embed_and_insert.py | — | Google Gemini API key |
| `CHUNKER_INPUT_FOLDER` | all three scripts | — | Absolute path to folder with source documents |
| `CHUNKER_OUTPUT_FOLDER` | chunker.py, embed_and_insert.py | — | Absolute path for JSON output files |
| `CHUNKS_FILE` | embed_and_insert.py | `$CHUNKER_OUTPUT_FOLDER/all_chunks.json` | Explicit path to the combined chunks JSON; optional if `CHUNKER_OUTPUT_FOLDER` is set |
| `DB_HOST` | embed_and_insert.py | — | Supabase DB host |
| `DB_PORT` | embed_and_insert.py | — | `5432` for Supabase |
| `DB_NAME` | embed_and_insert.py | — | `postgres` for Supabase |
| `DB_USER` | embed_and_insert.py | — | `postgres` for Supabase |
| `DB_PASSWORD` | embed_and_insert.py | — | Your Supabase database password |
| `DB_SSLMODE` | embed_and_insert.py | `require` | SSL mode for psycopg2; must be `require` for Supabase |

### `.env.example` (safe to commit)

Located at `chunking_documentation/.env.example`. Contains all variables with placeholder values and explanatory comments. Never contains real secrets.

### Your `.env` (gitignored)

Located at `chunking_documentation/.env`. This file is already present and gitignored. Confirm it contains:

```
GEMINI_API_KEY=<your real Gemini API key>

CHUNKER_INPUT_FOLDER=<absolute path to your source docs folder>
CHUNKER_OUTPUT_FOLDER=<absolute path to your output JSON folder>
CHUNKS_FILE=<absolute path to all_chunks.json, or omit>

DB_HOST=db.arguklcilpywhqofdlsm.supabase.co
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=<your Supabase DB password>
DB_SSLMODE=require
```

**The `DB_SSLMODE=require` line is mandatory.** Without it, `psycopg2` defaults to `prefer`, which may attempt an unencrypted connection that Supabase rejects.

---

## 3. Supabase Schema Setup (SQL Editor)

Open your Supabase project → **SQL Editor** → **New query**. Run the following SQL exactly as written. It is safe to re-run — all statements are idempotent.

### Step A — Enable pgvector

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Verify it installed:

```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

Expected: one row returned.

### Step B — Create the `document_chunks` table

The embedding dimension **must be 768**. This matches the output of `gemini-embedding-001`, which is hardcoded in `embed_and_insert.py:58`.

```sql
CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id        TEXT        PRIMARY KEY,
    source_file     TEXT        NOT NULL,
    doc_type        TEXT,
    section_title   TEXT,
    chunk_index     INTEGER,
    self_contained  BOOLEAN,
    missing_context TEXT,
    summary         TEXT,
    text            TEXT        NOT NULL,
    embed_input     TEXT,
    embedding       vector(768),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Why 768?** `embed_and_insert.py:58` calls `model="gemini-embedding-001"`. That model produces 768-dimensional vectors. Using any other number will cause a `psycopg2` error when the `::vector` cast is applied.

### Step C — Create the HNSW index for vector search

```sql
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
    ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

This enables fast approximate nearest-neighbor search using cosine distance — the same operator used by the RAG server (`embedding <=> $vector`).

**Note:** HNSW index creation on an empty table is instant. On a large table it takes time; the table remains queryable during build.

### Run all three steps together

You can paste the full block into a single SQL Editor query:

```sql
-- Step A
CREATE EXTENSION IF NOT EXISTS vector;

-- Step B
CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id        TEXT        PRIMARY KEY,
    source_file     TEXT        NOT NULL,
    doc_type        TEXT,
    section_title   TEXT,
    chunk_index     INTEGER,
    self_contained  BOOLEAN,
    missing_context TEXT,
    summary         TEXT,
    text            TEXT        NOT NULL,
    embed_input     TEXT,
    embedding       vector(768),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Step C
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
    ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

---

## 4. Running the Pipeline

All commands must be run from the **repository root** (`agent_natzig/`). The scripts use `load_dotenv()` which looks for `chunking_documentation/.env` relative to the current working directory.

> **Important:** `load_dotenv()` without arguments searches for `.env` in the current working directory and parent directories. Running from the repo root means the scripts will find `chunking_documentation/.env` only if it also exports variables — or you must `cd` into `chunking_documentation/` first, or pass the path explicitly. **The safest approach is to run from inside `chunking_documentation/`:**

```
cd chunking_documentation
```

All commands below assume you are inside `chunking_documentation/`.

---

### Stage 0 — Convert PDF and DOCX to Markdown

**Run only if your source documents are PDF or DOCX. Skip if they are already `.md`.**

```
python markdown_converter.py
```

**What it does:**
- Reads all `*.pdf` files from `CHUNKER_INPUT_FOLDER`, converts each to Markdown via `pymupdf4llm`, writes `<stem>.md` into the same folder
- Reads all `*.docx` files from `CHUNKER_INPUT_FOLDER`, extracts paragraph text, converts to Markdown via `markdownify`, writes `<stem>.md` into the same folder
- Each file is handled independently; failures are caught and logged, the rest continue

**Expected terminal output:**
```
📄 Converting PDF: document1.pdf
  ✅ Saved as document1.md
📄 Converting DOCX: document2.docx
  ✅ Saved as document2.md

✅ All conversions done! You can now run chunker.py
```

**Produces:** `.md` files written into `CHUNKER_INPUT_FOLDER` alongside the originals.

---

### Stage 1 — Chunk and Enrich

```
python chunker.py
```

**What it does:**
- Scans `CHUNKER_INPUT_FOLDER` for all `*.md` files
- For each file, sends the full text to `gemini-2.5-flash` to split into logical sections (Pass 1)
- For each section, sends it back to `gemini-2.5-flash` to assess self-containedness and enrich if needed (Pass 2)
- Assigns each chunk a **deterministic ID**: `SHA-256(filename + ":" + chunk_index)` as a 64-char hex string
- Writes one `<stem>_chunks.json` per file and one `all_chunks.json` combining all files into `CHUNKER_OUTPUT_FOLDER`

**Expected terminal output:**
```
📄 Processing: document1.md
  Splitting document with LLM...
    LLM identified 12 sections
    Reviewing chunk 1/12: 'Introduction to the System'...
    Reviewing chunk 2/12: 'Installation Requirements'...
    ...
  ✅ 12 chunks → document1_chunks.json

📄 Processing: document2.md
  ...

──────────────────────────────────────────────────
✅ All done!
   Files processed : 2
   Total chunks    : 24
   Enriched chunks : 5 (21% needed context)
   Output folder   : /your/output/folder/
```

**Produces:**
- `CHUNKER_OUTPUT_FOLDER/document1_chunks.json`
- `CHUNKER_OUTPUT_FOLDER/document2_chunks.json`
- `CHUNKER_OUTPUT_FOLDER/all_chunks.json`

**API calls made:** 1 Gemini LLM call per document (splitting) + 1 call per section (review). For 2 documents with 12 sections each: 26 API calls total.

---

### Stage 2 — Embed and Insert into Supabase

```
python embed_and_insert.py
```

**What it does:**
- Reads `all_chunks.json` from `CHUNKS_FILE` (or `$CHUNKER_OUTPUT_FOLDER/all_chunks.json`)
- For each chunk, calls `gemini-embedding-001` to generate a 768-dimensional embedding vector
- Inserts (or updates) the row in `document_chunks` using an UPSERT on `chunk_id`
- Waits 0.5 seconds between chunks to stay within Gemini rate limits
- Connects to Supabase with `sslmode=require`

**Expected terminal output:**
```
Connected to Postgres. Inserting 24 chunks...

  [1/24] Embedding: 'Introduction to the System'...
  [2/24] Embedding: 'Installation Requirements'...
  ...
  [24/24] Embedding: 'Troubleshooting — Error Codes'...

✅ Done! 24 chunks inserted.
```

**Produces:** Rows in the `document_chunks` table in Supabase.

**API calls made:** 1 Gemini embedding call per chunk. For 24 chunks: 24 API calls, ~12 seconds of sleep alone.

---

### Run all three stages in sequence

```
python markdown_converter.py && python chunker.py && python embed_and_insert.py
```

The `&&` operator stops the chain if any stage exits with a non-zero code (i.e., an unhandled error or a missing env var).

---

## 5. Expected Outputs

### Local files produced

| File | Produced by | Contents |
|---|---|---|
| `$CHUNKER_INPUT_FOLDER/<stem>.md` | Stage 0 | Markdown conversion of each source PDF/DOCX |
| `$CHUNKER_OUTPUT_FOLDER/<stem>_chunks.json` | Stage 1 | Array of chunk dicts for one source file |
| `$CHUNKER_OUTPUT_FOLDER/all_chunks.json` | Stage 1 | Array of all chunks from all source files |

### Each chunk in the JSON has these fields

| Field | Type | Source |
|---|---|---|
| `chunk_id` | string (64-char hex) | `SHA-256(filename + ":" + chunk_index)` — deterministic |
| `source_file` | string | Filename (basename only, no directory) |
| `doc_type` | string | Keyword-matched from filename: `faq`, `error_guide`, `user_guide`, `regulation`, `manual` |
| `section_title` | string | LLM-assigned section title |
| `chunk_index` | integer | 0-based position within the source file |
| `self_contained` | boolean | Whether the chunk needed context injection |
| `missing_context` | string or null | Description of missing context; null if self-contained |
| `summary` | string | One-sentence summary from the review LLM |
| `text` | string | Final chunk text (may be enriched with a context sentence) |
| `embed_input` | string | `summary + "\n\n" + text` — the string sent to the embedding model |

### Rows inserted in Supabase

One row per chunk in `document_chunks`. The `embedding` column is the 768-float vector produced by `gemini-embedding-001` from the `embed_input` field. The `created_at` column is set by Postgres to the current timestamp on first insert; it is **not** updated on subsequent UPSERT runs.

---

## 6. Verifying the Data in Supabase

Open **Supabase SQL Editor** and run these queries after Stage 2 completes.

### Count total rows inserted

```sql
SELECT COUNT(*) FROM document_chunks;
```

Expected: matches the "Total chunks" number printed by Stage 1.

### View the first 10 rows (without the embedding vector)

```sql
SELECT
    chunk_id,
    source_file,
    doc_type,
    section_title,
    chunk_index,
    self_contained,
    LENGTH(text) AS text_chars,
    created_at
FROM document_chunks
ORDER BY source_file, chunk_index
LIMIT 10;
```

### Confirm embeddings are populated (not NULL)

```sql
SELECT
    COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
    COUNT(*) FILTER (WHERE embedding IS NULL)     AS without_embedding
FROM document_chunks;
```

Expected: `without_embedding = 0`.

### Check rows per source file

```sql
SELECT source_file, doc_type, COUNT(*) AS chunks
FROM document_chunks
GROUP BY source_file, doc_type
ORDER BY source_file;
```

### Verify a deterministic chunk ID is stable

Pick any chunk from `all_chunks.json` and compare its `chunk_id` to what is in the database:

```sql
SELECT chunk_id, source_file, chunk_index, section_title
FROM document_chunks
WHERE chunk_id = '<paste chunk_id from JSON here>';
```

Expected: exactly one row returned.

### Test a vector similarity search

```sql
-- Replace the zeros with a real query embedding to test retrieval
-- This form tests that the index and operator work correctly
SELECT chunk_id, source_file, section_title,
       1 - (embedding <=> embedding) AS self_similarity
FROM document_chunks
LIMIT 5;
```

Expected: `self_similarity = 1.0` for all rows (a vector compared to itself has cosine distance 0, so similarity = 1).

---

## 7. Idempotency — How Re-Runs Behave

### Chunk ID generation

`chunk_id` is now deterministic: `SHA-256(filename + ":" + chunk_index)`. This means:
- Running Stage 1 twice on the same file produces the same `chunk_id` values
- The same file, same position → always the same ID

This is the key that makes the UPSERT work correctly.

### UPSERT behavior in Stage 2

`embed_and_insert.py` uses:

```sql
ON CONFLICT (chunk_id) DO UPDATE SET
    source_file     = EXCLUDED.source_file,
    doc_type        = EXCLUDED.doc_type,
    section_title   = EXCLUDED.section_title,
    chunk_index     = EXCLUDED.chunk_index,
    self_contained  = EXCLUDED.self_contained,
    missing_context = EXCLUDED.missing_context,
    summary         = EXCLUDED.summary,
    text            = EXCLUDED.text,
    embed_input     = EXCLUDED.embed_input,
    embedding       = EXCLUDED.embedding
```

Result of re-running Stage 2 on the same `all_chunks.json`:
- **Unchanged files:** existing rows are updated with identical values — effectively a no-op at the data level
- **Changed files:** if you re-ran Stage 1 after editing a source document, the new `text`, `summary`, and `embedding` overwrite the old values for the same position

### What re-running does NOT handle

- If the LLM splits a re-processed document into **fewer sections** than before, the old extra rows remain in the database (their chunk IDs will not appear in the new `all_chunks.json`, so they are never touched by Stage 2). To remove stale rows from a specific file, run:

```sql
DELETE FROM document_chunks
WHERE source_file = 'your_filename.md'
  AND chunk_index >= <new_section_count>;
```

---

## 8. Troubleshooting

### `ERROR: Required environment variable 'X' is not set`

The script failed at startup because a variable is missing from `.env`. Open `chunking_documentation/.env`, add the missing variable, and re-run.

### `connection to server ... failed: SSL connection has been closed unexpectedly`

`DB_SSLMODE` is not set or is set to `disable`. Supabase requires SSL. Confirm `DB_SSLMODE=require` is present in your `.env`.

### `FATAL: password authentication failed for user "postgres"`

`DB_PASSWORD` is wrong or not loaded. Confirm the `.env` file is in the same directory you are running the script from (i.e., `chunking_documentation/`).

### `UnicodeDecodeError` on a source file

A `.md` file in `CHUNKER_INPUT_FOLDER` is not UTF-8 encoded. Stage 1 opens all files with `encoding='utf-8'` and will crash on this file. Re-encode the file to UTF-8 before running.

### `⚠️ No .md files found in the input folder`

Stage 0 has not run yet (or completed with errors), or `CHUNKER_INPUT_FOLDER` points to the wrong path. Verify the path and confirm `.md` files are present.

### `relation "document_chunks" does not exist`

The Supabase schema setup was not completed. Return to [Section 3](#3-supabase-schema-setup-sql-editor) and run the SQL.

### `ERROR: type "vector" does not exist`

The pgvector extension is not enabled. Run `CREATE EXTENSION IF NOT EXISTS vector;` in the Supabase SQL Editor.

### `invalid input syntax for type vector`

The embedding list format passed to `%s::vector` is malformed. This would indicate an unexpected change in how `get_embedding()` returns data. Verify `response.embeddings[0].values` returns a plain Python list of floats and that `str(embedding)` produces something like `[0.1, 0.2, ...]`.

### Stage 2 prints `⚠️ Error on chunk N: ...` for some chunks but continues

Each chunk is wrapped in its own `try/except`. Errors on individual chunks are logged and skipped; the rest of the batch continues. After Stage 2 completes, run the verification query in [Section 6](#6-verifying-the-data-in-supabase) to confirm `without_embedding = 0`. If some chunks were skipped, re-run Stage 2 — the UPSERT ensures already-inserted chunks are updated in place and not duplicated.
