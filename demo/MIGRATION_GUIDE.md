# Migration Guide - From Monolithic to Layered Architecture

## What Changed

The original `rag.ts` file (585 lines) has been refactored into a multi-layered architecture with 13 files:

**Before:**
```
demo/
├── rag.ts (585 lines - everything mixed together)
├── migrate.ts
├── schema.ts
└── package.json
```

**After:**
```
demo/
├── src/
│   ├── routes/           (3 files - HTTP handling)
│   ├── controllers/      (1 file - business logic)
│   ├── services/         (4 files - database & API calls)
│   ├── utils/            (4 files - shared utilities)
│   └── index.ts          (main entry point)
├── migrate.ts
├── schema.ts
└── package.json
```

## Breaking Changes

### Entry Point Changed

**Old:**
```bash
npm start  # runs dist/rag.js
```

**New:**
```bash
npm start  # runs dist/index.js
npm run dev  # runs src/index.ts directly with ts-node
```

### TypeScript Configuration

**Old:**
```json
{
  "rootDir": "./"
}
```

**New:**
```json
{
  "rootDir": "./src",
  "include": ["src/**/*"]
}
```

This means all `import` statements must use relative paths from `src/`:
```typescript
// Old (from root):
import { Chunk } from "./rag";

// New (from src/):
import { Chunk } from "../utils/types";
```

## If You Modified rag.ts

### Case 1: You added a new configuration value

Move it to `src/utils/config.ts`:
```typescript
// Before
const MY_SETTING = process.env.MY_VAR || "default";

// After - in config.ts
export const MY_CONFIG = {
  mySetting: process.env.MY_VAR || "default",
} as const;

// Usage in services/controllers
import { MY_CONFIG } from "../utils/config";
console.log(MY_CONFIG.mySetting);
```

### Case 2: You modified the RAG pipeline logic

Edit the appropriate file:
- **Embedding/search:** `src/services/embedding.service.ts`
- **Prompts:** `src/services/prompt.service.ts`
- **Gemini calls:** `src/services/gemini.service.ts`
- **Pipeline stages:** `src/services/rag-pipeline.service.ts`
- **Pipeline orchestration:** `src/controllers/rag.controller.ts`

### Case 3: You added a new endpoint

1. Create `src/routes/myfeature.route.ts`:
```typescript
import { Router, Request, Response } from "express";
import { myFeatureController } from "../controllers/my-feature.controller";

export const myRouter = Router();

myRouter.post("/my-endpoint", async (req, res) => {
  try {
    const result = await myFeatureController(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

2. Create `src/controllers/my-feature.controller.ts` if needed

3. Register in `src/index.ts`:
```typescript
import { myRouter } from "./routes/myfeature.route";
app.use(myRouter);
```

### Case 4: You need to add middleware

1. Create middleware function:
```typescript
// src/utils/middleware.ts
export function myMiddleware(req, res, next) {
  // ...
  next();
}
```

2. Register in `src/index.ts`:
```typescript
import { myMiddleware } from "./utils/middleware";
app.use(myMiddleware);
```

## Updating Imports When Using the Refactored Code

If you have other files that imported from the old `rag.ts`:

### Old Pattern
```typescript
// Somewhere else in the project
import { Chunk, embedQuestion, callGemini } from "./demo/rag";

function myFunction() {
  const embedding = await embedQuestion("test");
}
```

### New Pattern
```typescript
// Services are now organized by domain
import { Chunk } from "./demo/src/utils/types";
import { embedQuestion } from "./demo/src/services/embedding.service";
import { callGemini } from "./demo/src/services/gemini.service";

function myFunction() {
  const embedding = await embedQuestion("test");
}
```

## Database & Schema - No Changes

The following files remain unchanged:
- `migrate.ts` - Run once to create schema (no changes needed)
- `schema.ts` - Drizzle ORM schema (already modularized)
- `package.json` - Updated entry point only
- `.env` - No changes

## Environment Variables - No Changes

The following still work the same:
```
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
GEMINI_API_KEY, LANGSMITH_API_KEY
PORT, NODE_ENV
RENDER, RENDER_GIT_COMMIT
DB_SSL
```

## TypeScript Compilation

**Build command:**
```bash
npm run build
```

This compiles `src/**/*.ts` to `dist/**/*.js` using the updated `tsconfig.json`.

The output structure will be:
```
dist/
├── routes/
├── controllers/
├── services/
├── utils/
└── index.js
```

## Testing After Migration

### 1. Build the project
```bash
npm run build
```

### 2. Check for compilation errors
If `npm run build` passes, all type checking is successful.

### 3. Run the server
```bash
npm start
```

Should see:
```
[BOOT] rag.ts signature = 2026-02-25-A
[startup] DB connected OK
[startup] document_chunks: N rows
[startup] DB embedding column: vector(768) → ...
🚀 RAG server running on http://localhost:3000
```

### 4. Test endpoints
```bash
# Health check
curl http://localhost:3000/healthz

# Ask endpoint
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "test question"}'
```

## Backwards Compatibility

### What's the same:
✅ All endpoints work identically  
✅ All request/response formats are identical  
✅ All business logic is the same  
✅ Database schema is unchanged  
✅ Configuration via environment variables works the same  

### What's different:
❌ File structure (but this is internal)  
❌ Where entry point is (from `dist/rag.js` to `dist/index.js`)  
❌ Internal module paths (but public APIs are the same)  

## Rollback Instructions

If something breaks and you need the old code:

1. The original `rag.ts` is still in the old location (we didn't delete it)
2. Revert `package.json` to point to `dist/rag.js`
3. Your old code will still work

However, we recommend fixing the issues in the new architecture because:
- It's much easier to maintain
- It's easier to test individual pieces
- It's easier to add new features
- It follows industry best practices

## Need Help?

Refer to:
- `ARCHITECTURE.md` - Complete system overview
- Comments in code - Every file and function is commented
- `src/*/` files - Look at adjacent files for examples
- Layer responsibilities - Each layer has a clear purpose

## Summary of File Movements

| Old Location | New Location | Purpose |
|---|---|---|
| rag.ts (embedding) | services/embedding.service.ts | Vector operations |
| rag.ts (Gemini) | services/gemini.service.ts | LLM API calls |
| rag.ts (prompts) | services/prompt.service.ts | LangSmith management |
| rag.ts (pipeline) | services/rag-pipeline.service.ts | Two-stage RAG logic |
| rag.ts (/ask route) | routes/ask.route.ts | HTTP /ask endpoint |
| rag.ts (/v1/resolve) | routes/resolve.route.ts | HTTP /v1/resolve endpoint |
| rag.ts (/healthz) | routes/health.route.ts | HTTP health check |
| rag.ts (pipeline) | controllers/rag.controller.ts | Orchestration logic |
| rag.ts (types) | utils/types.ts | TypeScript interfaces |
| rag.ts (config) | utils/config.ts | Configuration |
| rag.ts (logging) | utils/logger.ts | Structured logging |
| rag.ts (DB setup) | utils/database.ts | Connection & health |
| rag.ts (main) | index.ts | Application start |

All functionality is preserved - just organized better! 🎉
