# CLAUDE.md — ai_agent_service_minatzig_demo

## What is this project

AI service for the Minatzig customer support platform.
Handles RAG (Retrieval-Augmented Generation), document ingestion, and AI agent logic
that connects to the main backend (minatzig_server) to power intelligent responses.

This repository contains two separate projects:

---

## Project 1 — Python agent (root)

Experimental LangGraph-based chatbot. Entry point for agent logic prototyping.

**Stack:** Python · LangGraph · LangChain · OpenRouter API
**Files:** `main.py`, `debug.py`
**Run:** `python main.py`
**Config:** Requires `OPENROUTER_API_KEY` in `.env`

This is the exploratory layer. New agent patterns are tested here before being
promoted to the `demo/` service.

---

## Project 2 — RAG API service (`demo/`)

Production-oriented RAG API with Express, PostgreSQL, and LangChain.
This is the active project — all serious development happens here.

**Stack:** Node.js 20+ · TypeScript · Express 5 · Drizzle ORM · PostgreSQL · LangChain · LangSmith · Google Genai · CommonJS
**Entry point:** `demo/src/index.ts`
**Structure:**
```
demo/
├── src/
│   ├── controllers/   # Request handlers
│   ├── routes/        # Express route definitions
│   ├── services/      # Business logic and AI integrations
│   └── utils/         # Shared utilities
├── migrate.ts         # Database migration runner
├── package.json
└── tsconfig.json
```

**Key commands (run from inside demo/):**
```bash
cd demo
npm run dev      # Development server (ts-node)
npm run build    # TypeScript compile
npm start        # Run production build
```

**Config:** Requires environment variables in `demo/.env`

---

## Repository structure

```
ai_agent_service_minatzig_demo/
├── chunking_documentation/   # Documentation chunking experiments
├── demo/                     # Active RAG API service (TypeScript)
├── docs/                     # Project documentation
├── main.py                   # Python agent prototype
├── debug.py                  # API key diagnostics script
└── .gitignore
```

---

## Branch model

| Branch | Purpose |
|--------|---------|
| `main` | Single active branch — all work happens here |

A `dev` / `prod` branch separation will be introduced when the service moves
toward production integration with minatzig_server.

---

## Commit convention

Use **Conventional Commits** — always in English, lowercase:

```
feat(demo): add document chunking endpoint
fix(demo): handle empty query in RAG service
chore(demo): update langchain to 1.2.25
feat(agent): add multi-turn memory to python chatbot
```

**Scopes:** `demo` for the TypeScript service · `agent` for the Python layer · `docs` for documentation

---

## How this service connects to Minatzig

This service is consumed by `minatzig_server` (the main backend).
The integration point is via HTTP API — minatzig_server calls this service's endpoints
to get AI-generated responses for customer conversations.

When making changes, always consider the contract with minatzig_server:
- Do not break existing API endpoints without coordinating with the backend team.
- New endpoints should be additive, not breaking.

---

## What Claude must never do

- Modify `demo/` and root Python files in the same commit — they are separate projects
- Hardcode API keys or credentials anywhere
- Break the existing Express routes without checking how minatzig_server uses them
- Create verification markdown files in the root