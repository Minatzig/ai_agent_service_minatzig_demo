# RAG API - Architecture & Guide

## System Architecture

This project follows a **3-layer architecture** with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      HTTP REQUEST                                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                      ROUTES LAYER                                   │
│  • HTTP request parsing & validation                                │
│  • Parameter extraction from request body                           │
│  • HTTP response formatting                                         │
│  Files: src/routes/*.route.ts                                       │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                   CONTROLLERS LAYER                                 │
│  • Business logic orchestration                                     │
│  • Calling services in correct order                                │
│  • Error handling & fallback logic                                  │
│  • Request context management                                       │
│  Files: src/controllers/*.controller.ts                             │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                    SERVICES LAYER                                   │
│  • Database queries & transactions                                  │
│  • External API calls (Gemini, LangSmith)                          │
│  • Data transformation & formatting                                 │
│  Files: src/services/*.service.ts                                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│              EXTERNAL SERVICES & DATABASES                          │
│  • PostgreSQL with pgvector                                         │
│  • Gemini API (embeddings & generation)                            │
│  • LangSmith (prompt management)                                    │
└─────────────────────────────────────────────────────────────────────┘
```

## Folder Structure

```
demo/
├── src/
│   ├── routes/
│   │   ├── ask.route.ts          # POST /ask endpoint
│   │   ├── resolve.route.ts      # POST /v1/resolve endpoint
│   │   └── health.route.ts       # GET /healthz endpoint
│   │
│   ├── controllers/
│   │   └── rag.controller.ts     # RAG pipeline orchestration
│   │
│   ├── services/
│   │   ├── embedding.service.ts   # Vector embeddings & search
│   │   ├── gemini.service.ts      # Gemini API calls
│   │   ├── prompt.service.ts      # LangSmith prompt management
│   │   └── rag-pipeline.service.ts# Two-stage RAG pipeline
│   │
│   ├── utils/
│   │   ├── config.ts             # Configuration & environment variables
│   │   ├── database.ts           # Database connection & health checks
│   │   ├── logger.ts             # Structured logging utilities
│   │   └── types.ts              # TypeScript type definitions
│   │
│   └── index.ts                  # Main application entry point
│
├── migrate.ts                    # Database schema migration script
├── schema.ts                     # Drizzle ORM schema definitions
├── package.json                  # Dependencies & scripts
└── tsconfig.json                 # TypeScript configuration
```

## Layer Responsibilities

### Routes Layer (`src/routes/`)

**Responsibility:** HTTP interface

Routes are **thin** - they only handle HTTP concerns:
- Parse and validate request bodies
- Call controllers with extracted parameters
- Handle and format HTTP responses
- Return appropriate status codes (200, 400, 500)
- Add request tracking/logging headers

**Example:**
```typescript
askRouter.post("/ask", async (req, res) => {
  // 1. Extract & validate input
  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({...});
  
  // 2. Call controller with input
  const result = await executeRAGPipeline(question, reqId);
  
  // 3. Format & send HTTP response
  return res.json({...});
});
```

**Files:**
- `ask.route.ts` - Full RAG response with logic & sources
- `resolve.route.ts` - Minimal RAG response (answer text only)
- `health.route.ts` - Health check endpoint

---

### Controllers Layer (`src/controllers/`)

**Responsibility:** Business logic orchestration

Controllers **orchestrate** services to implement business logic:
- Coordinate the RAG pipeline sequence
- Call services in the correct order
- Implement fallback logic (e.g., when data_checker returns invalid IDs)
- Validate service outputs
- Aggregate results for formatting

**Controllers are independent of Express** - they take plain parameters and return plain objects.

**Example:**
```typescript
export async function executeRAGPipeline(question: string, reqId: string) {
  // 1. Call embedding service
  const embedding = await embedQuestion(question);
  
  // 2. Call retrieval service
  const chunks = await retrieveChunks(embedding, TOP_K);
  
  // 3. Call RAG pipeline services
  const checkerResult = await runDataChecker(question, chunks);
  
  // 4. Validate & implement fallback logic
  const relevantChunks = validateAndGetRelevantChunks(checkerResult, chunks);
  
  // 5. Call final answer generation service
  const finalAnswer = await runRespuestaFinal(question, relevantChunks);
  
  // 6. Aggregate and return results
  return { answer, logic, citation, sources };
}
```

**Files:**
- `rag.controller.ts` - RAG pipeline orchestration

---

### Services Layer (`src/services/`)

**Responsibility:** Database & external API calls

Services are **not aware of HTTP** - they implement pure business functions:
- Make database queries
- Call external APIs (Gemini, LangSmith)
- Transform and format data
- Implement domain-specific logic

**Services don't know about routes or controllers** - they're reusable functions.

**Example:**
```typescript
// Database query
export async function retrieveChunks(embedding: number[]): Promise<Chunk[]> {
  const result = await db.execute(sql`
    SELECT ... FROM document_chunks WHERE embedding <=> ...
  `);
  return result.rows;
}

// External API call
export async function embedQuestion(question: string): Promise<number[]> {
  const response = await gemini.models.embedContent({...});
  return response.embeddings[0].values;
}

// Orchestrate other services
export async function runDataChecker(question: string, chunks: Chunk[]) {
  const prompt = await buildPrompt(PROMPT_NAME, {...});
  const response = await callGemini(prompt);
  return parseJSON(response);
}
```

**Files:**
- `embedding.service.ts` - Vector embeddings, similarity search
- `gemini.service.ts` - Gemini API calls
- `prompt.service.ts` - LangSmith prompt management
- `rag-pipeline.service.ts` - Two-stage (data_checker, respuesta_final) logic

---

## RAG Pipeline Details

The RAG system works in 6 steps:

### Step 1: Embedding
- **Service:** `embedding.service.ts`
- **Function:** `embedQuestion(question)`
- Converts user question to 768-dimensional vector using Gemini Embedding API

### Step 2: Retrieval
- **Service:** `embedding.service.ts`
- **Function:** `retrieveChunks(embedding, topK)`
- Searches PostgreSQL/pgvector for top-K semantically similar documents
- Returns ranked chunks by cosine similarity

### Step 3: Data Checker
- **Service:** `rag-pipeline.service.ts`
- **Function:** `runDataChecker(question, chunks)`
- Uses LangSmith prompt `data_checker:885899c9`
- LLM selects up to 2 most relevant documents from top-K results
- Returns document IDs with reasoning

### Step 4: Validation
- **Service:** `rag-pipeline.service.ts`
- **Function:** `validateAndGetRelevantChunks(checkerResult, chunks)`
- Ensures data_checker only selected real document IDs
- Prevents hallucinated IDs from being passed to final answer stage
- Falls back to top-2 vector results if validation fails

### Step 5: Final Answer Generation
- **Service:** `rag-pipeline.service.ts`
- **Function:** `runRespuestaFinal(question, relevantChunks)`
- Uses LangSmith prompt `respuesta_final:77fd31b5`
- LLM generates comprehensive answer using ONLY the validated documents
- Returns structured response (answer, logic, documentation)

### Step 6: Response Formatting
- **Controller:** `rag.controller.ts`
- Maps source chunks to reference format
- Aggregates execution metrics
- Returns complete response to route

---

## Utilities & Config

### `utils/config.ts`
Centralized configuration management:
- Validates required environment variables at startup
- Exports configuration objects (APP_CONFIG, DB_CONFIG, LANGSMITH_CONFIG, etc.)
- Detects environment (production vs development)
- Prevents hardcoded values throughout the codebase

### `utils/database.ts`
Database connection & initialization:
- Creates PostgreSQL connection pool with Drizzle ORM
- Performs health checks during startup
- Validates schema and row counts

### `utils/logger.ts`
Structured logging utilities:
- `genId()` - Generate request trace IDs
- `log(reqId, stage, extra)` - Log pipeline stages
- `logError(reqId, stage, err)` - Log errors with context

### `utils/types.ts`
TypeScript type definitions used across all layers:
- Request/response interfaces
- Domain objects (Chunk, RelevantDocument, etc.)
- Ensures type safety throughout the codebase

---

## Adding New Features

### Adding a New Route

1. Create new file: `src/routes/feature.route.ts`
2. Define route handler
3. Call controller function
4. Handle errors and format response
5. Mount router in `src/index.ts`: `app.use(featureRouter)`

### Adding a Service Function

1. Create/edit file in `src/services/`
2. Implement function with database/API calls
3. Add TypeScript types
4. Document with comments explaining responsibility
5. Export function for controller use

### Modifying the RAG Pipeline

Edit `src/controllers/rag.controller.ts` to change:
- Pipeline step sequence
- Error handling
- Fallback logic
- Response formatting

Edit `src/services/rag-pipeline.service.ts` to change:
- Prompt names/versions
- LLM selection logic
- Validation rules

---

## Environment Variables

Required in `.env`:
```
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=...
DB_USER=...
DB_PASSWORD=...
DB_SSL=false  # or "true" for Render

# APIs
GEMINI_API_KEY=...
LANGSMITH_API_KEY=...

# Server
PORT=3000
NODE_ENV=development  # or "production"

# Deployment
RENDER_GIT_COMMIT=...  # Set automatically by Render
RENDER=true            # Set automatically by Render
```

---

## Running the Application

```bash
# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build

# Run compiled version
npm start

# Or run development version directly with ts-node
npm run dev

# Database migration (run once)
npx ts-node migrate.ts
```

The server will:
1. Validate required environment variables
2. Connect to PostgreSQL database
3. Detect embedding dimension alignment
4. Start listening on port 3000

Endpoints:
- `GET /healthz` - Health check
- `POST /ask` - Full RAG response
- `POST /v1/resolve` - Minimal RAG response

---

## Key Design Principles

### 1. Separation of Concerns
- Routes only handle HTTP
- Controllers orchestrate logic
- Services call external systems
- No mixing of concerns

### 2. Testability
- Services can be unit tested without Express
- Controllers can be tested with mock services
- Routes can be integration tested with mock controllers

### 3. Reusability
- Services can be used in different contexts
- Controllers can be called from CLI, cron jobs, etc.
- Logic is not tied to Express/HTTP

### 4. Maintainability
- Clear responsibility for each layer
- Easy to add new services without affecting routes
- Easy to modify pipeline logic without touching routes

### 5. Error Handling
- Controllers catch and transform errors
- Services throw detailed errors
- Routes format errors as HTTP responses
- Request IDs enable end-to-end tracing

---

## Extending the System

### Add a new LLM service
1. Create `src/services/claude.service.ts`
2. Implement `callClaude()` function
3. Add to config
4. Update controllers to use conditionally

### Add a new embedding model
1. Edit `src/services/embedding.service.ts`
2. Update `embedQuestion()` to use new model
3. Update `detectDimensions()` for dimension alignment
4. Re-ingest documents with new dimensions

### Add request authentication
1. Create middleware in `src/utils/`
2. Add to Express in `src/index.ts`
3. Routes can access user context

### Add caching layer
1. Create `src/services/cache.service.ts`
2. Call cache before database queries
3. Controllers determine cache strategy

---

## Debugging

### View logs by request ID
All logs include `reqId=` for identification:
```bash
# Render log viewer
grep "reqId=abc123" render.log

# Local terminal
npm run dev 2>&1 | grep "reqId=abc123"
```

### Add debug logging
Services use `console.log()` and `console.warn()`
Controllers use `log()` and `logError()` utilities
Routes use middleware logging

### Performance profiling
Each stage logs its duration: `durationMs=...`
Summing all stages should equal total request time

---

## Testing Endpoints

### Ask Endpoint
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is in the documents?"}'
```

### Resolve Endpoint
```bash
curl -X POST http://localhost:3000/v1/resolve \
  -H "Content-Type: application/json" \
  -d '{"text": "What is in the documents?"}'
```

### Health Check
```bash
curl http://localhost:3000/healthz
```
