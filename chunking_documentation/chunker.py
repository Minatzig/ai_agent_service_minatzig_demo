import uuid
import json
import os
from pathlib import Path
from google import genai

# ── Configuration ─────────────────────────────────────────────────────────────

GEMINI_API_KEY = "AIzaSyDvPjSnCKsZXGLvoNE6JT0F7JAEc2RE1sY"

INPUT_FOLDER  = "/Users/adinisman/Downloads/dynatech/input_docs"   # ← PUT YOUR INPUT PATH HERE
OUTPUT_FOLDER = "/Users/adinisman/Downloads/dynatech/output_docs"  # ← PUT YOUR OUTPUT PATH HERE

client = genai.Client(api_key=GEMINI_API_KEY)

# ── Step 1: LLM splits the document into logical sections ─────────────────────

def split_document_with_llm(text: str, filename: str) -> list[dict]:
    """
    Send the full document to Gemini and ask it to identify logical sections.
    Returns a list of { title, content } dicts.
    """
    prompt = f"""You are processing a document to prepare it for a RAG (Retrieval Augmented Generation) system.
Your task is to split the following document into logical, self-contained sections.

Rules:
- Each section should represent one clear topic, concept, or procedure
- Sections should be meaningful on their own — not too small (at least 2-3 sentences) and not too large
- Preserve all the original text, do not summarize or omit anything
- Use the document's own structure as a guide (headings, numbered items, bold titles, topic changes)
- For tables, keep them together with their title/context in the same section

Document filename: {filename}

Document text:
\"\"\"
{text}
\"\"\"

Respond ONLY with a valid JSON array. Each element must have:
- "title": a short descriptive title for the section (your own words, not necessarily from the text)
- "content": the full original text of that section, copied verbatim

Example format:
[
  {{"title": "General Requirements", "content": "...full text..."}},
  {{"title": "Data Fields", "content": "...full text..."}}
]

Return only raw JSON, no markdown fences, no explanation."""

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt
    )

    raw = response.text.strip()
    raw = raw.replace("```json", "").replace("```", "").strip()

    sections = json.loads(raw)
    print(f"    LLM identified {len(sections)} sections")
    return sections


# ── Step 2: LLM reviews each chunk and enriches if needed ─────────────────────

def review_chunk(title: str, body: str, prev_body: str = None) -> dict:
    """
    Ask Gemini to review a chunk and enrich it if it lacks context.
    """
    context_block = ""
    if prev_body:
        context_block = f"""
<previous_section>
{prev_body[:1500]}
</previous_section>
"""

    prompt = f"""You are reviewing a chunk of technical documentation for a RAG system.
Assess whether this chunk is self-contained and meaningful on its own.

{context_block}
<current_chunk_title>{title}</current_chunk_title>
<current_chunk_body>
{body}
</current_chunk_body>

Answer ONLY with a valid JSON object with these exact fields:
- "self_contained": true or false
- "missing_context": short string explaining what is missing, or null if self_contained
- "summary": one sentence describing what question this chunk answers
- "enriched_text": if NOT self_contained, rewrite by prepending a brief context sentence. If self_contained, return the original body unchanged.

Return only raw JSON, no markdown fences, no explanation."""

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt
    )

    raw = response.text.strip()
    raw = raw.replace("```json", "").replace("```", "").strip()

    return json.loads(raw)


# ── Full document pipeline ─────────────────────────────────────────────────────

def process_document(filepath: str, doc_type: str = "manual") -> list[dict]:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    filename = os.path.basename(filepath)
    print(f"  Splitting document with LLM...")
    sections = split_document_with_llm(content, filename)

    if not sections:
        print(f"  ⚠️  No sections returned for {filename}")
        return []

    final_chunks = []

    for i, section in enumerate(sections):
        title = section.get("title", f"Section {i+1}")
        body  = section.get("content", "")

        if not body.strip():
            continue

        print(f"    Reviewing chunk {i+1}/{len(sections)}: '{title[:60]}'...")

        prev_body = sections[i - 1].get("content", "") if i > 0 else None

        try:
            review = review_chunk(title, body, prev_body)
        except (json.JSONDecodeError, Exception) as e:
            print(f"    ⚠️  LLM review error on chunk {i+1}, keeping raw. Error: {e}")
            review = {
                "self_contained":  True,
                "missing_context": None,
                "summary":         title,
                "enriched_text":   body
            }

        final_chunks.append({
            "chunk_id":        str(uuid.uuid4()),
            "source_file":     filename,
            "doc_type":        doc_type,
            "section_title":   title,
            "chunk_index":     i,
            "self_contained":  review["self_contained"],
            "missing_context": review.get("missing_context"),
            "summary":         review["summary"],
            "text":            review["enriched_text"],
            "embed_input":     f"{review['summary']}\n\n{review['enriched_text']}"
        })

    return final_chunks


def get_doc_type(filename: str) -> str:
    name = filename.lower()
    if "faq"          in name: return "faq"
    if "error"        in name: return "error_guide"
    if "cartilla"     in name: return "user_guide"
    if "comunicacion" in name: return "regulation"
    if "manual"       in name: return "manual"
    return "manual"


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    input_path  = Path(INPUT_FOLDER)
    output_path = Path(OUTPUT_FOLDER)
    output_path.mkdir(parents=True, exist_ok=True)

    md_files = list(input_path.glob("*.md"))

    if not md_files:
        print("⚠️  No .md files found in the input folder.")
        print(f"    Make sure your files are in: {INPUT_FOLDER}")
        exit()

    all_chunks = []

    for md_file in md_files:
        print(f"\n📄 Processing: {md_file.name}")
        doc_type = get_doc_type(md_file.name)
        chunks   = process_document(str(md_file), doc_type=doc_type)
        all_chunks.extend(chunks)

        per_file_output = output_path / f"{md_file.stem}_chunks.json"
        with open(per_file_output, 'w', encoding='utf-8') as f:
            json.dump(chunks, f, indent=2, ensure_ascii=False)
        print(f"  ✅ {len(chunks)} chunks → {per_file_output.name}")

    combined_output = output_path / "all_chunks.json"
    with open(combined_output, 'w', encoding='utf-8') as f:
        json.dump(all_chunks, f, indent=2, ensure_ascii=False)

    total    = len(all_chunks)
    enriched = sum(1 for c in all_chunks if not c["self_contained"])
    print(f"\n{'─'*50}")
    print(f"✅ All done!")
    print(f"   Files processed : {len(md_files)}")
    print(f"   Total chunks    : {total}")
    print(f"   Enriched chunks : {enriched} ({round(enriched/total*100) if total else 0}% needed context)")
    print(f"   Output folder   : {OUTPUT_FOLDER}")
