"""
One-time script: reads all_chunks.json, generates embeddings with Gemini,
and inserts everything into Postgres.

Install dependencies:
  pip install google-genai psycopg2-binary python-dotenv
"""

import json
import time
import os
import psycopg2
from google import genai
from dotenv import load_dotenv

load_dotenv()


# ── Configuration ─────────────────────────────────────────────────────────────

def _require(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise SystemExit(
            f"ERROR: Required environment variable '{name}' is not set.\n"
            f"       Copy chunking_documentation/.env.example to "
            f"chunking_documentation/.env and fill in your values."
        )
    return val


GEMINI_API_KEY = _require("GEMINI_API_KEY")

# CHUNKS_FILE can be set explicitly, or derived from CHUNKER_OUTPUT_FOLDER
_output_folder = os.environ.get("CHUNKER_OUTPUT_FOLDER", "")
CHUNKS_FILE = os.environ.get("CHUNKS_FILE") or (
    os.path.join(_output_folder, "all_chunks.json") if _output_folder else None
)
if not CHUNKS_FILE:
    raise SystemExit(
        "ERROR: Either 'CHUNKS_FILE' or 'CHUNKER_OUTPUT_FOLDER' must be set.\n"
        "       Copy chunking_documentation/.env.example to "
        "chunking_documentation/.env and fill in your values."
    )

_require("DB_HOST")
_require("DB_PORT")
_require("DB_NAME")
_require("DB_USER")
_require("DB_PASSWORD")

# ── Setup ─────────────────────────────────────────────────────────────────────

client = genai.Client(api_key=GEMINI_API_KEY)

def get_embedding(text: str) -> list[float]:
    response = client.models.embed_content(
        model="gemini-embedding-001",
        contents=text
    )
    return response.embeddings[0].values


def insert_chunks(chunks: list[dict]):
    conn = psycopg2.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        dbname=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        sslmode=os.environ.get("DB_SSLMODE", "require"),
    )
    cur = conn.cursor()

    print(f"Connected to Postgres. Inserting {len(chunks)} chunks...\n")

    for i, chunk in enumerate(chunks):
        print(f"  [{i+1}/{len(chunks)}] Embedding: '{chunk['section_title'][:60]}'...")

        try:
            embedding = get_embedding(chunk["embed_input"])

            cur.execute("""
                INSERT INTO document_chunks (
                    chunk_id, source_file, doc_type, section_title,
                    chunk_index, self_contained, missing_context,
                    summary, text, embed_input, embedding
                ) VALUES (
                    %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s::vector
                )
                ON CONFLICT (chunk_id) DO UPDATE SET
                    source_file     = EXCLUDED.source_file,
                    doc_type        = EXCLUDED.doc_type,
                    section_title   = EXCLUDED.section_title,
                    chunk_index     = EXCLUDED.chunk_index,
                    self_contained  = EXCLUDED.self_contained,
                    missing_context = EXCLUDED.missing_context,
                    summary         = EXCLUDED.summary,
                    text            = EXCLUDED.text,
                    embed_input     = EXCLUDED.embed_input,
                    embedding       = EXCLUDED.embedding
            """, (
                chunk["chunk_id"],
                chunk["source_file"],
                chunk["doc_type"],
                chunk["section_title"],
                chunk["chunk_index"],
                chunk["self_contained"],
                chunk.get("missing_context"),
                chunk["summary"],
                chunk["text"],
                chunk["embed_input"],
                str(embedding)
            ))

            conn.commit()
            time.sleep(0.5)  # avoid Gemini rate limits

        except Exception as e:
            print(f"  ⚠️  Error on chunk {i+1}: {e}")
            conn.rollback()
            continue

    cur.close()
    conn.close()
    print(f"\n✅ Done! {len(chunks)} chunks inserted.")


if __name__ == "__main__":
    with open(CHUNKS_FILE, "r", encoding="utf-8") as f:
        chunks = json.load(f)

    insert_chunks(chunks)
