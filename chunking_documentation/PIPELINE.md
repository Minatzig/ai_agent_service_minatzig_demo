# Chunking Documentation Pipeline

Complete pipeline for converting documents to embeddings for RAG systems:

## Pipeline Steps

### Step 1: Convert Documents to Markdown
**File:** `markdown_converter.py`

Converts PDF and DOCX files to markdown format while preserving structure.

```bash
python markdown_converter.py
```

**Input:** `CHUNKER_INPUT_FOLDER` (PDF and DOCX files)  
**Output:** Markdown files in the same folder

**Supported formats:**
- PDF (using pymupdf4llm for better structure preservation)
- DOCX (using python-docx)

---

### Step 2: Convert Images to Text Descriptions *(NEW)*
**File:** `image_converter.py`

Processes markdown files to detect and convert images into text descriptions using Gemini's vision capabilities. This ensures all embeddings are based on text content only.

```bash
python image_converter.py
```

**Input:** Markdown files from Step 1 (`.md` in `CHUNKER_INPUT_FOLDER`)  
**Output:** Text-only markdown files in `CHUNKER_OUTPUT_FOLDER/cleaned_documents/`

**What it does:**
1. Scans markdown for image references (both `![alt](path)` and `<img>` tags)
2. For each image:
   - Extracts surrounding text context (before and after)
   - Sends image + context to Gemini 2.0 Flash Vision
   - Gets back a detailed text description
   - Replaces the image reference with the description
3. Creates cleaned documents with all images converted to descriptions
4. Logs conversion statistics

**Why this step matters:**
- Embeddings work best with text-only content
- Images can't be directly embedded
- Vision descriptions preserve all image information in text form
- Improves RAG retrieval quality

---

### Step 3: Split Documents into Chunks
**File:** `chunker.py`

Uses Gemini to split cleaned documents into logical, self-contained chunks with enrichment.

```bash
python chunker.py
```

**Input:** Markdown files (now from `cleaned_documents/`)  
**Output:** JSON files with chunks in `CHUNKER_OUTPUT_FOLDER/`

**What it does:**
1. **Split:** Uses LLM to identify logical sections based on content structure
2. **Enrich:** Reviews each chunk for self-containment and adds context if needed
3. **Generate:** Creates comprehensive summaries for better embedding quality
4. **Output:**
   - Per-file JSON: `{filename}_chunks.json`
   - Combined: `all_chunks.json`

---

### Step 4: Generate Embeddings and Insert to Database
**File:** `embed_and_insert.py`

Generates vector embeddings and stores chunks in PostgreSQL.

```bash
python embed_and_insert.py
```

**Input:** `all_chunks.json` from Step 3  
**Output:** Vectors in PostgreSQL `document_chunks` table

**What it does:**
1. Reads all chunks from JSON
2. Generates embeddings using Gemini Embedding API
3. Inserts chunks with embeddings into Postgres
4. Handles conflicts (updates if chunk already exists)

---

## Environment Setup

Create `.env` file in `chunking_documentation/` folder:

```env
# Gemini API
GEMINI_API_KEY=your_api_key_here

# File paths
CHUNKER_INPUT_FOLDER=/path/to/source/documents
CHUNKER_OUTPUT_FOLDER=/path/to/output/chunks

# PostgreSQL (for embedding insertion)
DB_HOST=your-db-host
DB_PORT=5432
DB_NAME=your_database
DB_USER=postgres
DB_PASSWORD=your_password
DB_SSLMODE=require
```

---

## Complete Workflow Example

```bash
# 1. Prepare input documents
cp *.pdf *.docx /path/to/input_folder/

# 2. Convert PDFs/DOCX to Markdown
python markdown_converter.py

# 3. Convert images to descriptions (NEW STEP)
python image_converter.py
# This creates cleaned_documents/ with text-only files

# 4. Split into chunks
# Edit .env to point CHUNKER_INPUT_FOLDER to cleaned_documents/
python chunker.py

# 5. Generate embeddings and insert to database
python embed_and_insert.py
```

---

## Key Improvements

- **Pre-processing pipeline:** Document conversion → Image handling → Chunking
- **Better embeddings:** Text-only chunks improve embedding quality
- **Image intelligence:** Gemini vision preserves image information as descriptions
- **Flexible formatting:** Handles multiple input formats (PDF, DOCX) and markdown image styles
- **Tracking:** Statistics saved for auditing and debugging

---

## Troubleshooting

### No images found
- Check that images are embedded in markdown or referenced as local files
- Verify image files exist in the input directory
- Check markdown syntax: `![alt](path/to/image.png)`

### Image conversion timeout
- Large images may take longer to process
- Check Gemini API rate limits
- Consider processing documents in batches

### Chunks not enriching properly
- Ensure previous chunker review step is working
- Check Gemini API responses in error logs

---

## Architecture Notes

- **Modular design:** Each step is independent and can be run separately
- **State tracking:** Each step outputs stats JSON for verification
- **Error handling:** Failures in image conversion don't block the pipeline
- **Reversible:** Original documents are preserved; cleaned versions are in separate folder
