# Chunking Pipeline - Quick Start Card

## Complete 4-Step Workflow

### Step 1: Convert Documents to Markdown
```bash
python markdown_converter.py
```
📥 Input: `.pdf`, `.docx` files  
📤 Output: `.md` files

---

### Step 2: Convert Images to Descriptions ⭐ NEW
```bash
python image_converter.py
```
📥 Input: `.md` files with images  
📤 Output: `cleaned_documents/` with text-only `.md` files + stats JSON

**What it does:**
- 🖼️ Detects images in markdown
- 🔍 Extracts surrounding text context
- 🤖 Sends to Gemini vision for description
- 📝 Replaces images with text descriptions
- 💾 Saves cleaned documents

---

### Step 3: Split Documents into Chunks
```bash
# Copy cleaned documents back to input folder (or update .env)
cp cleaned_documents/*.md input_folder/

python chunker.py
```
📥 Input: Text-only `.md` files  
📤 Output: `all_chunks.json`, `{file}_chunks.json`

---

### Step 4: Generate Embeddings & Insert to DB
```bash
python embed_and_insert.py
```
📥 Input: `all_chunks.json`  
📤 Output: Vectors in PostgreSQL

---

## One-Line Summary

```
PDF/DOCX → Markdown → Remove Images → Chunks → Embeddings → Database
           (step 1)   (step 2)       (step 3)   (step 4)
```

---

## Directory Structure After Processing

```
input_folder/
  ├── original.pdf
  ├── original.docx
  ├── markdown.md           ← From step 1
  └── ...

output_folder/
  ├── cleaned_documents/    ← From step 2
  │   ├── markdown.md       ← No images
  │   └── _image_conversion_stats.json
  ├── markdown_chunks.json  ← From step 3
  ├── all_chunks.json       ← From step 3
  └── ...
```

---

## Environment Variables Needed

```env
GEMINI_API_KEY=your_key
CHUNKER_INPUT_FOLDER=/path/to/input
CHUNKER_OUTPUT_FOLDER=/path/to/output
DB_HOST=localhost
DB_PORT=5432
DB_NAME=database
DB_USER=postgres
DB_PASSWORD=password
```

---

## Key Files

| File | Purpose | When to run |
|------|---------|------------|
| `markdown_converter.py` | PDF/DOCX → MD | First (one-time) |
| `image_converter.py` | MD → Remove images | Second (new step!) |
| `chunker.py` | MD → Chunks | Third |
| `embed_and_insert.py` | Chunks → Database | Fourth (one-time) |

---

## Monitoring & Stats

Check conversion results:
```bash
# View image conversion report
cat output_folder/cleaned_documents/_image_conversion_stats.json

# View chunk statistics
cat output_folder/all_chunks.json | jq 'length'  # Total chunks

# Check embeddings inserted
psql -U postgres -d database -c "SELECT COUNT(*) FROM document_chunks;"
```

---

## Troubleshooting Quick Links

| Issue | Solution |
|-------|----------|
| No images detected | Check markdown syntax: `![alt](path)` |
| API errors | Verify `GEMINI_API_KEY` |
| Slow processing | Large images take longer, normal |
| File copy issues | Use `cp` or copy via file explorer |
| Embeddings fail | Ensure Postgres connection works |

---

## 🎯 What Changed in the Pipeline

**Before:**
```
Documents → Markdown → Chunks → Embeddings
```

**Now:**
```
Documents → Markdown → Images→Text → Chunks → Embeddings
                       ^^^^^^^^^^^^^^
                       (NEW STEP!)
```

**Why:**
- Embeddings work best with text-only content
- Images converted to descriptions preserve all information
- Better RAG retrieval quality
- No manual image handling needed

---

## ⚡ Execute Full Pipeline

```bash
#!/bin/bash
# Complete automation

echo "Step 1: Converting to Markdown..."
python markdown_converter.py

echo "Step 2: Converting images to descriptions..."
python image_converter.py

echo "Step 3: Splitting into chunks..."
cp cleaned_documents/*.md input_folder/
python chunker.py

echo "Step 4: Generating embeddings..."
python embed_and_insert.py

echo "✅ Pipeline complete!"
```

Save as `run_pipeline.sh` and run:
```bash
chmod +x run_pipeline.sh
./run_pipeline.sh
```

---

## 📚 Documentation Files

- `IMAGE_CONVERTER_GUIDE.md` - Detailed guide for image converter
- `PIPELINE.md` - Complete architecture documentation  
- `IMPLEMENTATION_SUMMARY.md` - Technical implementation details
- `IMAGE_CONVERTER_REQUIREMENTS.txt` - Dependencies (none new!)

---

## ✅ Next Steps

1. Review image converter: `cat image_converter.py | head -50`
2. Run the pipeline: `python image_converter.py`
3. Check results: `cat cleaned_documents/_image_conversion_stats.json`
4. Continue: `python chunker.py`

**You're all set!** 🚀
