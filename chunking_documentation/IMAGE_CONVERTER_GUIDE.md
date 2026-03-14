# Image Converter - Quick Start Guide

## What's New

A new **image conversion step** has been added to your chunking pipeline:

- **File:** `image_converter.py`
- **Purpose:** Convert images in markdown to text descriptions using Gemini vision
- **When to run:** After `markdown_converter.py`, before `chunker.py`

## Why You Need This

1. **Embeddings work with text:** LLM embeddings can't process images directly
2. **No information loss:** Gemini describes images based on context
3. **Better RAG:** Text descriptions make retrieval more accurate
4. **Pipeline flow:** Ensures all documents are text-only before chunking

## How It Works

```
Original document with images
         ↓
markdown_converter.py (PDF/DOCX → .md)
         ↓
image_converter.py (images → descriptions) ← NEW
         ↓
chunker.py (.md → chunks)
         ↓
embed_and_insert.py (chunks → database with embeddings)
```

## Updated Workflow

### 1. Prepare Documents
```bash
cp your_documents/*.pdf your_documents/*.docx /path/to/input_folder/
```

### 2. Convert to Markdown
```bash
python markdown_converter.py
```
Creates: `input_folder/*.md`

### 3. **Convert Images to Descriptions** (NEW)
```bash
python image_converter.py
```

**This step:**
- 📸 Finds all images in markdown files
- 🔍 Extracts context around each image
- 🤖 Sends to Gemini to generate descriptions
- 📝 Replaces images with descriptions
- 💾 Saves cleaned documents to `output_folder/cleaned_documents/`

**Output files:**
- `cleaned_documents/*.md` - Text-only markdown (ready for chunker)
- `cleaned_documents/_image_conversion_stats.json` - Conversion report

### 4. Update Configuration (One-time)

Your `.env` file needs to point chunker to cleaned documents:

**Before (if you directly copy files back):**
```env
CHUNKER_INPUT_FOLDER=/path/to/input_folder/
CHUNKER_OUTPUT_FOLDER=/path/to/output_folder/
```

**Option A: Copy cleaned files back**
```bash
cp cleaned_documents/*.md input_folder/
# Then run chunker normally
python chunker.py
```

**Option B: Update .env for chunker.py**
Change `CHUNKER_INPUT_FOLDER` to:
```env
CHUNKER_INPUT_FOLDER=/path/to/output_folder/cleaned_documents/
```

### 5. Continue with Chunking
```bash
python chunker.py
```

### 6. Generate Embeddings
```bash
python embed_and_insert.py
```

## Important Features

### Context-Aware Descriptions
The image converter extracts **before and after context**:
- Takes up to 500 characters before the image
- Takes up to 500 characters after the image
- Sends both to Gemini along with the image
- Ensures descriptions are relevant to document context

### Supported Image Formats
- PNG ✅
- JPEG/JPG ✅
- GIF ✅
- WebP ✅

### Supported Markdown Syntax
- `![alt text](path/to/image.png)` - Standard markdown
- `<img src="path/to/image.png" />` - HTML tags

### Error Handling
- If an image can't be processed, it's logged but won't block the pipeline
- Partial failures are tracked in `_image_conversion_stats.json`
- Original markdown files are never modified

## Example Output

**Original markdown:**
```markdown
## System Architecture

The system is organized as follows:

![Architecture Diagram](diagrams/architecture.png)

The diagram shows three main layers...
```

**After image_converter.py:**
```markdown
## System Architecture

The system is organized as follows:

**[Architecture Diagram]** The diagram shows a three-tier architecture with client layer at the top, 
API gateway and microservices in the middle, and database layer at the bottom. 
Each microservice handles specific domain functions and communicates through message queues.

The diagram shows three main layers...
```

## Monitoring Progress

Check the conversion statistics:
```bash
cat cleaned_documents/_image_conversion_stats.json
```

Example output:
```json
[
  {
    "filename": "manual.md",
    "images_found": 5,
    "images_converted": 5,
    "errors": 0
  },
  {
    "filename": "guide.md",
    "images_found": 2,
    "images_converted": 2,
    "errors": 0
  }
]
```

## Troubleshooting

### "No images found" but I have images
- Check image paths are correct (relative to document location)
- Verify markdown syntax: `![](path/to/image.png)` or `<img src="..."/>`
- Check that image files actually exist in the folder

### Slow processing
- Large images take longer to send to Gemini
- API rate limiting may apply
- Consider running in off-peak hours for large batches

### API errors
- Verify `GEMINI_API_KEY` is set correctly
- Confirm you have Gemini 2.0 Flash Vision API access
- Check API quota/rate limits

## Architecture

The image converter is designed as a **pre-processing step**:
- ✅ Modular: Can skip if no images in documents
- ✅ Non-destructive: Original files unchanged
- ✅ Tracked: Statistics for each document
- ✅ Resumable: Can rerun on partially processed documents

## Next Steps

1. Run the complete pipeline with this new step
2. Review converted documents in `cleaned_documents/`
3. Check embedding quality with the enriched text descriptions
4. Adjust as needed for your specific document types

---

**Questions?** Check `PIPELINE.md` for full architecture details.
