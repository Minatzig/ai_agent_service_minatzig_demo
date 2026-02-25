# Chunking Pipeline — Environment Variable Refactor

**Date:** 2026-02-25
**Scope:** `chunking_documentation/markdown_converter.py`, `chunker.py`, `embed_and_insert.py`

---

## What Changed and Why

All three pipeline scripts previously contained hardcoded absolute paths pointing to specific developers' home directories. This made the pipeline impossible to run on any machine other than the original developer's, and forced path changes directly in source code before each run.

The refactor eliminates all hardcoded paths and replaces them with environment variables loaded from a `.env` file via `python-dotenv`.

---

## Files Modified

### `markdown_converter.py`

**Before:**
- `INPUT_FOLDER` was a hardcoded string literal (`/Users/adinisman/Downloads/dynatech/input_docs`)
- `OUTPUT_FOLDER` was defined as a hardcoded literal but was **never used** in the script — the converted Markdown files were always written back into `INPUT_FOLDER`
- No `dotenv` import or `load_dotenv()` call

**After:**
- Added `from dotenv import load_dotenv` and `load_dotenv()` at module load
- Added a `_require(name)` helper that exits with a clear error message if a variable is missing
- `INPUT_FOLDER` is now read from `CHUNKER_INPUT_FOLDER` via `_require()`
- The dead `OUTPUT_FOLDER` constant was removed (it was unused; keeping it would have been misleading)
- The "no files found" warning now prints the resolved folder path so the user can diagnose the problem immediately

### `chunker.py`

**Before:**
- `INPUT_FOLDER` was a hardcoded literal (`/Users/alenwuhl/Downloads/Development/dynatech-data/`)
- `OUTPUT_FOLDER` was a hardcoded literal (`/Users/alenwuhl/Downloads/Development/dynatech-data/output_docs/`)
- `GEMINI_API_KEY` was read via `os.environ["GEMINI_API_KEY"]` (crashes with a raw `KeyError` on failure)

**After:**
- Added a `_require(name)` helper with a clear, actionable error message
- `GEMINI_API_KEY` now uses `_require("GEMINI_API_KEY")` instead of bare `os.environ[]`
- `INPUT_FOLDER` now uses `_require("CHUNKER_INPUT_FOLDER")`
- `OUTPUT_FOLDER` now uses `_require("CHUNKER_OUTPUT_FOLDER")`
- All three are validated at import time, so the script fails immediately with a readable message before any API call or file I/O occurs

### `embed_and_insert.py`

**Before:**
- `GEMINI_API_KEY` read via `os.environ["GEMINI_API_KEY"]` (raw `KeyError` on failure)
- `CHUNKS_FILE` was a hardcoded literal (`/Users/alenwuhl/Downloads/Development/dynatech-data/output_docs/all_chunks.json`)
- DB credentials were read via bare `os.environ[]` inside `insert_chunks()` — errors only appeared at connection time

**After:**
- Added a `_require(name)` helper
- `GEMINI_API_KEY` validated at startup via `_require()`
- `CHUNKS_FILE` is resolved with a two-step fallback:
  - First checks `CHUNKS_FILE` env var (explicit override)
  - If not set, derives the path as `$CHUNKER_OUTPUT_FOLDER/all_chunks.json`
  - If neither is set, exits with a clear error
- All five DB variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) are validated at startup via `_require()`, before any file I/O or DB connection attempt
- All validation happens at module load time so failures are immediate and obvious

---

## New Files Created

### `chunking_documentation/.env.example`

Safe-to-commit template documenting every required and optional variable. Contains no secrets — all values are placeholder strings. This file should be committed to version control.

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key |
| `CHUNKER_INPUT_FOLDER` | Yes | — | Absolute path to source document folder (PDF/DOCX/MD) |
| `CHUNKER_OUTPUT_FOLDER` | Yes | — | Absolute path where chunked JSON files are written |
| `CHUNKS_FILE` | No | `$CHUNKER_OUTPUT_FOLDER/all_chunks.json` | Explicit path to combined chunks JSON for Stage 2 |
| `DB_HOST` | Yes | — | PostgreSQL host |
| `DB_PORT` | Yes | — | PostgreSQL port |
| `DB_NAME` | Yes | — | PostgreSQL database name |
| `DB_USER` | Yes | — | PostgreSQL user |
| `DB_PASSWORD` | Yes | — | PostgreSQL password |

### `chunking_documentation/.env`

Local working file for the current developer. Contains real folder paths, placeholder secret values. This file is gitignored via `chunking_documentation/.gitignore` and must never be committed.

The `GEMINI_API_KEY` and all `DB_*` fields are set to placeholder values — fill them in before running.

---

## Environment Variable Reference

### Path Relationship Between Stages

```
CHUNKER_INPUT_FOLDER
    ├── source.pdf        ← Stage 0 reads from here
    ├── source.docx       ← Stage 0 reads from here
    └── source.md         ← Stage 0 writes here; Stage 1 reads from here

CHUNKER_OUTPUT_FOLDER
    ├── source_chunks.json   ← Stage 1 writes (per-file)
    └── all_chunks.json      ← Stage 1 writes; Stage 2 reads from here
                               (unless CHUNKS_FILE overrides)
```

Stage 0 (`markdown_converter.py`) writes converted Markdown files back into `CHUNKER_INPUT_FOLDER` — the same folder it reads source documents from. This is intentional: Stage 1 reads `.md` files from `CHUNKER_INPUT_FOLDER`, so Stage 0's output must land there.

### `CHUNKS_FILE` Derivation Logic

`embed_and_insert.py` resolves `CHUNKS_FILE` as follows:

1. If `CHUNKS_FILE` is set in the environment → use it as-is
2. Else if `CHUNKER_OUTPUT_FOLDER` is set → use `$CHUNKER_OUTPUT_FOLDER/all_chunks.json`
3. Else → exit with an error

This means in the standard setup, only `CHUNKER_OUTPUT_FOLDER` needs to be set — `CHUNKS_FILE` can be omitted entirely.

---

## How to Run — Step-by-Step

### Prerequisites

- Python 3.x installed
- Required packages installed:
  - `google-genai`
  - `python-dotenv`
  - `pymupdf4llm`
  - `python-docx`
  - `markdownify`
  - `psycopg2-binary`
- A running PostgreSQL instance with the `pgvector` extension and the `document_chunks` table created (run `demo/migrate.ts` once to set this up)
- A valid Gemini API key

### Step 1 — Set Up Environment

Copy the example env file and fill in your values:

```
cp chunking_documentation/.env.example chunking_documentation/.env
```

Open `chunking_documentation/.env` and set:
- `GEMINI_API_KEY` — your real Gemini API key
- `CHUNKER_INPUT_FOLDER` — absolute path to the folder containing your PDF/DOCX/MD source files
- `CHUNKER_OUTPUT_FOLDER` — absolute path to a writable folder for JSON output
- All `DB_*` variables — your PostgreSQL connection details

### Step 2 — Stage 0: Convert PDF and DOCX to Markdown

Run from the repository root (or from `chunking_documentation/`):

```
python chunking_documentation/markdown_converter.py
```

This reads all `*.pdf` and `*.docx` files from `CHUNKER_INPUT_FOLDER` and writes a `<stem>.md` file alongside each source file in the same folder. Files that fail to convert are skipped with a warning; the others proceed.

Skip this stage if your source documents are already in Markdown format.

### Step 3 — Stage 1: Chunk and Enrich

```
python chunking_documentation/chunker.py
```

This reads all `*.md` files from `CHUNKER_INPUT_FOLDER`. For each file it makes two passes through the Gemini LLM: one to split the document into logical sections, one to review and enrich each section with context if needed.

Output:
- One `<stem>_chunks.json` file per source document in `CHUNKER_OUTPUT_FOLDER`
- One `all_chunks.json` combining all chunks in `CHUNKER_OUTPUT_FOLDER`

### Step 4 — Stage 2: Embed and Insert into PostgreSQL

```
python chunking_documentation/embed_and_insert.py
```

This reads `all_chunks.json` (from `CHUNKS_FILE` or `$CHUNKER_OUTPUT_FOLDER/all_chunks.json`), generates an embedding for each chunk using the Gemini embedding model, and inserts the rows into the `document_chunks` PostgreSQL table.

A 0.5-second delay is inserted between each chunk to stay within Gemini API rate limits. On error for any individual chunk, that chunk is skipped and the error is logged; the rest of the batch continues.

### Running All Three Stages in Sequence

```
python chunking_documentation/markdown_converter.py && \
python chunking_documentation/chunker.py && \
python chunking_documentation/embed_and_insert.py
```

The `&&` operator ensures each stage only runs if the previous one exited cleanly (exit code 0). If any stage fails (e.g., missing env var, folder not found), the chain stops immediately.

---

## Validation Behavior

All three scripts now fail at startup — before any file I/O or API call — if a required variable is missing. The error message names the missing variable and points to the `.env.example` file:

```
ERROR: Required environment variable 'CHUNKER_INPUT_FOLDER' is not set.
       Copy chunking_documentation/.env.example to chunking_documentation/.env and fill in your values.
```

`embed_and_insert.py` validates the five DB variables at startup even though the connection is not opened until `insert_chunks()` is called. This prevents wasting time embedding all chunks via the Gemini API only to fail at the DB insert step due to a missing credential.

---

## What Was Not Changed

- Business logic, LLM prompts, chunking algorithm, and output format are unchanged
- The `GEMINI_API_KEY` was already read from the environment in `chunker.py` and `embed_and_insert.py`; it is now validated via `_require()` instead of bare `os.environ[]`
- No new dependencies were introduced — `python-dotenv` was already used in both `chunker.py` and `embed_and_insert.py`
- `markdown_converter.py` now requires `python-dotenv` (added `from dotenv import load_dotenv`); this package is already a dependency of the other two scripts, so no new install is needed if all scripts share the same environment
