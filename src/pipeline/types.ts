import { createHash } from "crypto";

// Chunk format — matches the existing DB schema (poc_kb_chunks)
export interface Chunk {
  id: string;
  source: string;
  title: string;
  content: string;       // text_content for embedding + BM25
  metadata: {
    question: string;
    answer: string;
    tags: string[];
    parent_id: string | null;
    created_at: string | null;
    url: string | null;
  };
}

export interface SourceAdapter {
  /** Unique name, used as the `source` field in DB rows */
  name: string;
  /** Human-readable description (optional, for --list) */
  description?: string;
  /**
   * Export chunks from this source.
   * @param config - Key-value pairs from env vars + CLI args.
   */
  export(config: Record<string, string>): Promise<Chunk[]>;
}

// --- Helpers for embed/upload ---

export interface ExistingChunkRow {
  id: string;
  title: string | null;
  question: string | null;
  answer: string | null;
  text_content: string | null;
  tags: string[] | null;
  source: string | null;
  parent_id: string | null;
  created_at: string | null;
  url: string | null;
}

export function normalizeChunk(chunk: Chunk): Record<string, unknown> {
  return {
    title: chunk.title,
    question: chunk.metadata.question,
    answer: chunk.metadata.answer,
    text_content: chunk.content,
    tags: chunk.metadata.tags,
    source: chunk.source,
    parent_id: chunk.metadata.parent_id,
    created_at: chunk.metadata.created_at || null,
    url: chunk.metadata.url || null,
  };
}

export function normalizeExistingRow(row: ExistingChunkRow): Record<string, unknown> {
  return {
    title: row.title || "",
    question: row.question || "",
    answer: row.answer || "",
    text_content: row.text_content || "",
    tags: row.tags || [],
    source: row.source || "",
    parent_id: row.parent_id,
    created_at: row.created_at || null,
    url: row.url || null,
  };
}

export function hashChunkPayload(chunk: Chunk | ExistingChunkRow): string {
  const normalized = "content" in chunk ? normalizeChunk(chunk as Chunk) : normalizeExistingRow(chunk as ExistingChunkRow);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
