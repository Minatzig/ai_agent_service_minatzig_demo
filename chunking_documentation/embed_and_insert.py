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

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
CHUNKS_FILE    = "/Users/adinisman/Downloads/dynatech/output_docs/all_chunks.json"  # ← YOUR PATH HERE

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
        password=os.environ["DB_PASSWORD"]
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
                ON CONFLICT (chunk_id) DO NOTHING
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
