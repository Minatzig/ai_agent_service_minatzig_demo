// schema.ts
import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";

// gemini-embedding-001 outputs 768 dimensions
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace("[", "")
      .replace("]", "")
      .split(",")
      .map(Number);
  },
});

export const documentChunks = pgTable("document_chunks", {
  chunkId:        text("chunk_id").primaryKey(),
  sourceFile:     text("source_file").notNull(),
  docType:        text("doc_type"),
  sectionTitle:   text("section_title"),
  chunkIndex:     integer("chunk_index"),
  selfContained:  boolean("self_contained"),
  missingContext: text("missing_context"),
  summary:        text("summary"),
  text:           text("text").notNull(),
  embedInput:     text("embed_input"),
  embedding:      vector("embedding"),
  createdAt:      timestamp("created_at").defaultNow(),
});

export type DocumentChunk = typeof documentChunks.$inferSelect;
