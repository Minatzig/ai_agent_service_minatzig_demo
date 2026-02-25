# Render Deploy Changes — adi-repo-render-deploy

**Date:** 2026-02-24
**Scope:** Deployment readiness only. No RAG logic, retrieval, prompt, or handoff behavior was changed.

---

## What Was Changed — File by File

### `demo/package.json`

**Why:** The file had no `build` or `start` script and no `main` entry point pointing to compiled output. Render requires a compiled start command; running `ts-node` at runtime in production is unreliable and slow.

**Changes:**
- `main` changed from `"index.js"` to `"dist/rag.js"` (the compiled output path)
- Added `"build": "tsc"` script
- Added `"start": "node dist/rag.js"` script
- Added `"engines": { "node": ">=20.0.0" }` to pin Node version
- Added `"@types/node": "^20.0.0"` to `devDependencies`

**Why `@types/node`:** The existing `rag.ts` uses `process` and `console` throughout. Without `@types/node`, TypeScript compilation (`tsc`) fails because the `"lib": ["ES2021"]` setting does not include Node.js global types. This was previously masked by `ts-node`, which injects its own type resolution. Adding `@types/node` is required for `npm run build` to succeed on Render.

---

### `demo/tsconfig.json`

**Why:** Same reason as above — `tsc` could not resolve `process`, `console`, or other Node globals without explicit Node type declarations.

**Changes:**
- Added `"types": ["node"]` to `compilerOptions`

No other compiler options were touched.

---

### `demo/.nvmrc`

**Why:** Render reads `.nvmrc` to auto-detect the Node version. Pinning to `20` ensures the LTS version is used consistently across Render builds.

**Content:** `20`

---

### `demo/.env.example`

**Why:** The repo had no reference file for required environment variables. Developers and Render setup would have no documented list of what secrets to provide.

**Content:** Placeholder values (no real secrets) for all variables used by `demo/rag.ts`:
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `GEMINI_API_KEY`
- `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_ENDPOINT`
- `PORT`

---

### `demo/rag.ts`

**Why:** Three additions were required for Render readiness and the integration API contract. No existing logic was modified.

**Changes:**

1. **`GET /healthz`** — added before the `/ask` route.
   - Returns `{ "ok": true }` with HTTP 200.
   - Required by Render's health check system to confirm the service started successfully. Without it, Render marks the deployment as failed.

2. **`POST /v1/resolve`** — added after the `/ask` route, before the server startup block.
   - Accepts `{ "text": string }`.
   - Returns `{ "replyText": string }`.
   - Calls the same internal functions as `/ask` (`embedQuestion`, `retrieveChunks`, `runDataChecker`, `fetchChunksByIds`, `runRespuestaFinal`) in the same order with the same logic. No RAG behavior changed.
   - If escalation is triggered (no relevant documents), returns `{ "replyText": NO_ANSWER_MESSAGE }` — identical handoff behavior to `/ask`.
   - Logs timestamp and question length only — no prompt content logged.

3. **Startup log** — updated the `app.listen` callback to log all three endpoints (`/ask`, `/v1/resolve`, `/healthz`).

---

### `chunking_documentation/chunker.py`

**Why:** `GEMINI_API_KEY` was hardcoded as a string literal on line 9 of the source file. This is a security issue — the key is exposed in version control. The chunking logic itself was not changed.

**Changes:**
- Added `from dotenv import load_dotenv` import
- Added `load_dotenv()` call at module top (consistent with `embed_and_insert.py` which already does this)
- Changed `GEMINI_API_KEY = "AIzaSy..."` to `GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]`

The `os` module was already imported. Only the credential loading was changed.

---

### `.gitignore` (root)

**Why:** The IDE auto-inserted `docs/` into the root `.gitignore` during the session. This would have caused all documentation in `docs/` to be gitignored.

**Change:** Removed the `docs/` line that was auto-inserted. The `docs/` directory must be tracked by git.

---

## What Was NOT Changed

The following logic is **guaranteed unchanged**:

- All retrieval logic (`embedQuestion`, `retrieveChunks`, `fetchChunksByIds`)
- Both LLM pipeline stages (`runDataChecker`, `runRespuestaFinal`)
- Prompt fetching from LangSmith (`buildPrompt`, `hub.pull`)
- Escalation / handoff behavior (`NO_ANSWER_MESSAGE`, escalation conditions)
- The `/ask` endpoint (request shape, response shape, internal flow)
- Database schema (`schema.ts`)
- Database migration (`migrate.ts`)
- Vector search parameters (`TOP_K = 5`, cosine distance, HNSW index)
- Hardcoded `CLIENT_NAME` — intentionally left as-is per task scope
- Hardcoded LangSmith prompt commit hashes — intentionally left as-is
- Python ingestion pipeline logic (`chunker.py`, `embed_and_insert.py`, `markdown_converter.py`) — only the credential loading in `chunker.py` was changed

---

## How to Deploy on Render — Step by Step

### 1. Prerequisites

- A PostgreSQL database (Render Postgres or external) with pgvector enabled.
- Run the migration once: `cd demo && npx ts-node migrate.ts`
- A valid Gemini API key with access to `gemini-embedding-001` and `gemini-2.5-flash`.
- A valid LangSmith API key with access to the `data_checker` and `respuesta_final` prompts.

### 2. Create the Render Web Service

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub/GitLab repository
3. Set **Root Directory** to `demo`
4. Set **Environment** to `Node`
5. Set **Build Command** to: `npm install && npm run build`
6. Set **Start Command** to: `npm start`
7. Set **Node Version** to `20`

### 3. Set Environment Variables

In the Render service **Environment** tab, add:

| Key | Value |
|---|---|
| `DB_HOST` | your Postgres host |
| `DB_PORT` | `5432` |
| `DB_NAME` | your database name |
| `DB_USER` | your database user |
| `DB_PASSWORD` | your database password |
| `GEMINI_API_KEY` | your Gemini API key |
| `LANGSMITH_API_KEY` | your LangSmith API key |
| `LANGSMITH_TRACING` | `true` |
| `LANGSMITH_PROJECT` | your project name |
| `LANGSMITH_ENDPOINT` | `https://eu.api.smith.langchain.com` |

Do **not** set `PORT` — Render injects it automatically.

### 4. Deploy

Click **Deploy**. Render will:
1. Run `npm install && npm run build`
2. Start with `node dist/rag.js`
3. Ping `/healthz` to confirm the service is up

### 5. Verify

```bash
# Health check
curl https://your-service.onrender.com/healthz
# Expected: {"ok":true}

# RAG query
curl -X POST https://your-service.onrender.com/v1/resolve \
  -H "Content-Type: application/json" \
  -d '{"text": "What is the return policy?"}'
# Expected: {"replyText":"..."}
```

---

## Secrets Status

| Secret | Status | Location |
|---|---|---|
| `demo/.env` (DB password, Gemini key, LangSmith key) | Never committed — gitignored | Local disk only |
| `GEMINI_API_KEY` hardcoded in `chunker.py` | **Fixed** — now reads from env | `chunking_documentation/chunker.py` |
| Any key in `embed_and_insert.py` | Already correct — reads from env | No change needed |

The git history contains no committed `.env` files. Verified via `git log --all --full-history -- "demo/.env"` (no output).
