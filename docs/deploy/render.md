# Render Deployment Guide

## Service Type

**Web Service**

---

## Repository Root vs. Service Root

The TypeScript server lives inside the `demo/` subdirectory. Set **Root Directory** to `demo` in the Render service settings so that Render runs all commands from there.

---

## Build Command

```
npm install && npm run build
```

This installs all dependencies (including devDependencies needed for compilation) and compiles TypeScript to `dist/`.

## Start Command

```
npm start
```

Runs `node dist/rag.js` — the compiled output. No `ts-node` at runtime.

---

## Node Version

Pinned to Node 20 LTS via two mechanisms:

- `demo/.nvmrc` contains `20`
- `demo/package.json` contains `"engines": { "node": ">=20.0.0" }`

In Render service settings, set **Node Version** to `20` (or leave auto-detect enabled — it will read `.nvmrc`).

---

## Required Environment Variables

Set these in the Render service dashboard under **Environment**.

### Required

| Variable | Description |
|---|---|
| `DB_HOST` | PostgreSQL host (e.g. Render Postgres internal hostname) |
| `DB_PORT` | PostgreSQL port (default: `5432`) |
| `DB_NAME` | Database name |
| `DB_USER` | Database user |
| `DB_PASSWORD` | Database password |
| `GEMINI_API_KEY` | Google Gemini API key |
| `LANGSMITH_API_KEY` | LangSmith API key (used for prompt fetching and tracing) |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port (Render sets this automatically — leave unset) |
| `LANGSMITH_TRACING` | `true` | Set to `false` to disable LangSmith tracing |
| `LANGSMITH_PROJECT` | — | Project label in LangSmith dashboard |
| `LANGSMITH_ENDPOINT` | `https://eu.api.smith.langchain.com` | LangSmith API region endpoint |

> **Note:** `PORT` is injected automatically by Render. Do not set it manually.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Health check — returns `{ "ok": true }` |
| `POST` | `/v1/resolve` | Main RAG endpoint (stable API contract) |
| `POST` | `/ask` | Internal endpoint (same logic, kept for backwards compatibility) |

---

## curl Test

```bash
# Health check
curl https://your-service.onrender.com/healthz

# RAG query
curl -X POST https://your-service.onrender.com/v1/resolve \
  -H "Content-Type: application/json" \
  -d '{"text": "What is the return policy?"}'
```

Expected response shape:

```json
{
  "replyText": "..."
}
```

If no relevant documents are found, the service escalates to human:

```json
{
  "replyText": "Esta pregunta debe ser contestada por un humano."
}
```

---

## Pre-deployment: Database

The `document_chunks` table and pgvector extension must exist before starting the service. Run the migration once against your target database:

```bash
cd demo
npx ts-node migrate.ts
```

The migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

---

## Secrets — Important Notes

- `demo/.env` is gitignored and was **never committed** to the repository. Do not commit it.
- Use `demo/.env.example` as reference for required variable names.
- All secrets must be set via the Render environment variables dashboard — never in the repo.
- `chunking_documentation/chunker.py` previously had the Gemini API key hardcoded. This has been fixed to read from `GEMINI_API_KEY` environment variable.

---

## Debugging with Logs

Every request to `/ask` and `/v1/resolve` emits structured `[RAG]` prefixed log lines. In the Render log viewer, filter by `[RAG]` to isolate pipeline traces.

### Stage sequence for a healthy request

```
[RAG] reqId=abc123 stage=request_received method=POST path=/v1/resolve
[RAG] reqId=abc123 stage=input_validated
[RAG] reqId=abc123 stage=embedding_start
[RAG] reqId=abc123 stage=embedding_done durationMs=230
[RAG] reqId=abc123 stage=vector_search_start
[RAG] reqId=abc123 stage=vector_search_done durationMs=40 rows=5
[RAG] reqId=abc123 stage=data_checker_start
[RAG] reqId=abc123 stage=data_checker_done durationMs=1400 selected=2
[RAG] reqId=abc123 stage=chunk_fetch_start ids=2
[RAG] reqId=abc123 stage=chunk_fetch_done durationMs=15 rows=2
[RAG] reqId=abc123 stage=final_answer_start
[RAG] reqId=abc123 stage=final_answer_done durationMs=2100
[RAG] reqId=abc123 stage=response_sent status=200 totalMs=3800
```

### Escalated (no relevant docs found)

The pipeline stops after `data_checker_done` with `selected=0` and jumps directly to `response_sent`.

### How to pinpoint failures

| Log stops after... | Likely cause |
|---|---|
| `request_received` | Request body parsing failed or `question`/`text` missing |
| `embedding_start` | Gemini API key invalid or quota exceeded |
| `vector_search_start` | Postgres unreachable or pgvector not installed |
| `data_checker_start` | LangSmith unreachable or prompt name/commit invalid |
| `chunk_fetch_start` | data_checker returned IDs that don't exist in DB |
| `final_answer_start` | LangSmith unreachable for second prompt, or Gemini error |

### Error log format

```
[RAG] reqId=abc123 stage=pipeline ERROR message="connect ECONNREFUSED 127.0.0.1:5432"
<stack trace>
```

### Searching logs in Render

Use the Render log search bar with the filter string `[RAG] reqId=` to trace a single request end-to-end. The `reqId` is also the Twilio `MessageSid` when the request originates from a Twilio webhook.

---

## Known Limitations

- **No authentication:** The `/v1/resolve` endpoint has no API key or token validation. Restrict access at the network level (Render private service, VPC, or an upstream API gateway) until auth is added.
- **Hardcoded client name:** The client name `"Vicky"` is hardcoded in `demo/rag.ts`. It is passed as a prompt variable but not configurable via environment.
- **No conversation history:** Each request is stateless. Multi-turn conversation context is not implemented.
- **LangSmith required at runtime:** Prompts are fetched from LangSmith Hub on every request. If LangSmith is unreachable the service will return 500 errors. Ensure `LANGSMITH_API_KEY` is valid and `LANGSMITH_ENDPOINT` is correct for your region.
- **No rate limiting:** The service applies no per-IP or global request limits.
